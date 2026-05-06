import { ethers } from 'ethers';
import { getSupabaseAdmin } from '../lib/supabase-server.ts';
import { NAORIS_TOKEN_CONTRACT, TOTAL_SUPPLY, SEVERITY_THRESHOLDS } from '../constants.ts';
import { RiskLevel, AlertSeverity, AlertStatus, AlertRule, AlertRuleType } from '../types.ts';

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

let trackedAddresses: Set<string> = new Set();
let provider: ethers.JsonRpcProvider | null = null;
let contract: ethers.Contract | null = null;
const db = () => getSupabaseAdmin();

async function setupAddressTracking() {
  console.log("[Worker] Initializing address tracking...");
  const { data, error } = await db().from('wallets').select('*').eq('isActive', true);
  if (error) { console.error("[Worker] Address tracking error:", error); return; }
  const newAddresses = new Set<string>();
  (data || []).forEach((w: any) => newAddresses.add(w.address.toLowerCase()));
  trackedAddresses = newAddresses;
  console.log(`[Worker] Tracking updated: ${trackedAddresses.size} active wallets.`);

  // Subscribe to wallet changes for real-time tracking updates
  db().channel('worker-wallets').on('postgres_changes', { event: '*', schema: 'public', table: 'wallets' }, async () => {
    const { data: updated } = await db().from('wallets').select('*').eq('isActive', true);
    const addrs = new Set<string>();
    (updated || []).forEach((w: any) => addrs.add(w.address.toLowerCase()));
    trackedAddresses = addrs;
    console.log(`[Worker] Real-time tracking updated: ${trackedAddresses.size} active wallets.`);
  }).subscribe();
}

async function getTelemetry(txHash?: string) {
  if (!txHash || !provider) return {};
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return {};
    return { blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), gasPrice: receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') + ' Gwei' : undefined, networkHealth: 'Stable' };
  } catch (err) { console.warn(`[Worker] Could not fetch telemetry for ${txHash}:`, err); return {}; }
}

async function evaluateRules(userId: string, walletData: any, naorisBalance: number, txAmount?: number, txHash?: string) {
  try {
    const { data: rulesData } = await db().from('alertRules').select('*').eq('userId', userId).eq('isActive', true);
    const telemetry = await getTelemetry(txHash);
    for (const rule of (rulesData || []) as AlertRule[]) {
      let triggered = false;
      if (rule.ruleType === AlertRuleType.BALANCE_ABOVE || rule.ruleType === AlertRuleType.BALANCE_BELOW) {
        if (rule.comparison === 'greater_than' && naorisBalance > rule.threshold) triggered = true;
        if (rule.comparison === 'less_than' && naorisBalance < rule.threshold) triggered = true;
      }
      if (txAmount && rule.ruleType === AlertRuleType.LARGE_TRANSFER) { if (txAmount > rule.threshold) triggered = true; }
      if (triggered) {
        const alertData = { userId, alertType: `Rule Triggered: ${rule.name}`, severity: rule.severity, walletAddress: walletData.address, walletLabel: walletData.label, amount: txAmount || naorisBalance, txHash: txHash || '', reason: rule.description, recommendedAction: 'Autonomous detection triggered. Review entity history immediately.', status: AlertStatus.NEW, createdAt: Date.now(), ...telemetry };
        // Debounce: check for recent duplicates
        const { data: existing } = await db().from('alerts').select('id').eq('userId', userId).eq('walletAddress', walletData.address).eq('alertType', alertData.alertType).gt('createdAt', Date.now() - 3600000);
        if (!existing || existing.length === 0) {
          await db().from('alerts').insert(alertData);
          console.log(`[Worker] ALERT! ${rule.name} triggered for user ${userId} wallet ${walletData.label}`);
        }
      }
    }
  } catch (err) { console.error("[Worker] Error evaluating rules:", err); }
}

async function updateWalletBalanceRealtime(userId: string, address: string) {
  if (!contract || !provider) return;
  try {
    const naorisBalanceRaw = await contract.balanceOf(address);
    const ethBalanceRaw = await provider.getBalance(address);
    const naorisBalance = Number(ethers.formatUnits(naorisBalanceRaw, 18));
    const ethBalance = Number(ethers.formatEther(ethBalanceRaw));
    await db().from('wallets').update({ naorisBalance, ethBalance, lastActivityAt: Date.now(), updatedAt: Date.now() }).eq('userId', userId).eq('address', address);
    return naorisBalance;
  } catch (err) { console.error(`[Worker] Balance update error for ${address} (user: ${userId}):`, err); }
}

async function processTransaction(log: any) {
  const { from, to, value, transactionHash, blockNumber } = log;
  if (!from || !to) return;
  const fromLower = from.toLowerCase();
  const toLower = to.toLowerCase();
  const isFromMonitored = trackedAddresses.has(fromLower);
  const isToMonitored = trackedAddresses.has(toLower);

  if (isFromMonitored || isToMonitored) {
    console.log(`[Worker] Match detected! TX: ${transactionHash}`);
    const amountFormatted = Number(ethers.formatUnits(value, 18));
    const percentTotalSupply = (amountFormatted / TOTAL_SUPPLY) * 100;
    let riskLevel: RiskLevel = RiskLevel.LOW;
    if (amountFormatted >= SEVERITY_THRESHOLDS.CRITICAL) riskLevel = RiskLevel.CRITICAL;
    else if (amountFormatted >= SEVERITY_THRESHOLDS.HIGH) riskLevel = RiskLevel.HIGH;
    else if (amountFormatted >= SEVERITY_THRESHOLDS.MEDIUM) riskLevel = RiskLevel.MEDIUM;
    const activeAddr = isFromMonitored ? fromLower : toLower;

    try {
      const { data: walletSnap } = await db().from('wallets').select('*').eq('address', activeAddr);
      const telemetry = await getTelemetry(transactionHash);
      for (const wData of (walletSnap || [])) {
        const userId = wData.userId;
        const txData = { userId, txHash: transactionHash, blockNumber, timestamp: Date.now(), fromAddress: from, toAddress: to, amountRaw: value.toString(), amountFormatted, percentTotalSupply, tokenContract: NAORIS_TOKEN_CONTRACT, direction: isFromMonitored ? 'Outbound' : 'Inbound', riskLevel, status: 'Confirmed' };
        await db().from('transactions').upsert({ id: `${userId}_${transactionHash}`, ...txData });
        const currentBalance = await updateWalletBalanceRealtime(userId, activeAddr);
        await evaluateRules(userId, wData, currentBalance || Number(wData.naorisBalance || 0), amountFormatted, transactionHash);
        if (riskLevel !== RiskLevel.LOW || isFromMonitored) {
          const alertData = { userId, alertType: isFromMonitored ? 'Large Outbound Transfer' : 'Whale Accumulation', severity: riskLevel as unknown as AlertSeverity, walletAddress: activeAddr, walletLabel: wData.label, txHash: transactionHash, amount: amountFormatted, reason: `Heuristic check: Large movement of ${amountFormatted.toLocaleString()} NAORIS.`, recommendedAction: 'Monitor recipient address for secondary dispersals.', status: AlertStatus.NEW, createdAt: Date.now(), ...telemetry };
          await db().from('alerts').insert(alertData);
        }
      }
      console.log(`[Worker] Success: Processed ${transactionHash} for ${(walletSnap || []).length} monitors.`);
    } catch (err) { console.error("[Worker] Supabase multi-user write error:", err); }
  }
}

async function syncWalletBalances() {
  console.log("[Worker] Starting scheduled balance synchronization...");
  try {
    const { data: walletsData } = await db().from('wallets').select('*');
    for (const data of (walletsData || [])) {
      if (!data.isActive) continue;
      const address = data.address;
      try {
        const naorisBalanceRaw = await contract!.balanceOf(address);
        const ethBalanceRaw = await provider!.getBalance(address);
        const naorisBalance = Number(ethers.formatUnits(naorisBalanceRaw, 18));
        const ethBalance = Number(ethers.formatEther(ethBalanceRaw));
        await db().from('wallets').update({ naorisBalance, ethBalance, lastActivityAt: Date.now(), updatedAt: Date.now() }).eq('id', data.id);
        await evaluateRules(data.userId, data, naorisBalance);
        if (naorisBalance > SEVERITY_THRESHOLDS.CRITICAL) {
          await db().from('alerts').insert({ userId: data.userId, alertType: 'Critical Balance Detected', severity: AlertSeverity.CRITICAL, walletAddress: address, walletLabel: data.label, amount: naorisBalance, reason: `Heuristic check: Critical holding threshold exceeded (${naorisBalance.toLocaleString()}).`, status: AlertStatus.NEW, createdAt: Date.now() });
        }
      } catch (err) { console.error(`[Worker] Error syncing balance for ${address}:`, err); }
    }
    console.log("[Worker] Balance synchronization complete.");
  } catch (err) { console.error("[Worker] Error in syncWalletBalances:", err); }
}

export async function startWorker() {
  const rpcUrl = process.env.ETH_RPC_URL || "https://eth.llamarpc.com";
  provider = new ethers.JsonRpcProvider(rpcUrl);
  contract = new ethers.Contract(NAORIS_TOKEN_CONTRACT, ERC20_ABI, provider);
  console.log("[Worker] Starting NAORIS monitoring service...");
  await setupAddressTracking();
  await syncWalletBalances();
  setInterval(syncWalletBalances, 10 * 60 * 1000);
  const setupListener = () => {
    console.log("[Worker] Subscribing to Transfer events...");
    contract!.on("Transfer", (from, to, value, event) => {
      try { processTransaction({ from, to, value, transactionHash: event.log.transactionHash, blockNumber: event.log.blockNumber }); }
      catch (err) { console.error("[Worker] Event processing error:", err); }
    });
    provider!.on("error", (err) => { console.warn("[Worker] Provider error, reconnecting:", err); contract!.removeAllListeners(); setTimeout(setupListener, 10000); });
  };
  setupListener();
  setInterval(async () => {
    try {
      const block = await provider!.getBlockNumber();
      await db().from('sync').upsert({ id: 'ethereum', lastBlock: block, updatedAt: Date.now() });
    } catch (err: any) { console.warn("[Worker] Sync state warning:", err.message); }
  }, 120000);
}
