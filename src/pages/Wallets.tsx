import React, { useEffect, useState } from 'react';
import { supabase, handleSupabaseError, OperationType } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { Plus, Trash2, ExternalLink, ToggleLeft, ToggleRight, Shield, Layers, Search, X, RefreshCw, ChevronDown, ChevronRight, ArrowDownLeft, ArrowUpRight, Activity } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { formatAddress, formatNumber, cn } from '../lib/utils';
import { WalletType, Wallet, Transaction, RiskLevel } from '../types';

const walletSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  label: z.string().min(1, 'Label is required').max(50),
  walletType: z.nativeEnum(WalletType),
  alertsEnabled: z.boolean(),
});

type WalletForm = z.infer<typeof walletSchema>;

const GLOBAL_WALLETS = [
  { address: '0xaa2a4B4CD952645201D34f66F1C054b98ceF7263', label: 'DecubateVestingV3 (Proxy)', walletType: WalletType.TREASURY },
  { address: '0x76f998714623EE2d96E8cA834a6C942A67CaeB54', label: 'MultiSigWallet_1', walletType: WalletType.MULTISIG },
  { address: '0xE866F2dC5928E40a36a9F46a63F8005C72874FdB', label: 'Gnosis Safe Proxy', walletType: WalletType.GNOSIS },
  { address: '0xbc8821d23d5D064DE269dC6abec92d96C89BdD7a', label: 'MultiSigWallet_2', walletType: WalletType.MULTISIG },
];

export default function Wallets() {
  const { user } = useAuth();
  const [wallets, setWallets] = useState<Wallet[]>([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [isInitializing, setIsInitializing] = useState(false);
  
  // State for expanded wallet transactions
  const [expandedWallet, setExpandedWallet] = useState<string | null>(null);
  const [walletTxs, setWalletTxs] = useState<Record<string, Transaction[]>>({});
  const [loadingTxs, setLoadingTxs] = useState<Record<string, boolean>>({});

  const { register, handleSubmit, reset, formState: { errors } } = useForm<WalletForm>({
    resolver: zodResolver(walletSchema),
    defaultValues: { walletType: WalletType.UNKNOWN, alertsEnabled: true }
  });

  const fetchWallets = async () => {
    if (!user) return;
    const { data, error } = await supabase.from('wallets').select('*').eq('userId', user.id);
    if (error) { handleSupabaseError(error, OperationType.LIST, 'wallets'); return; }
    
    let currentWallets = data as Wallet[];
    let isMissingGlobals = false;
    
    for (const gw of GLOBAL_WALLETS) {
      if (!currentWallets.some(cw => cw.address.toLowerCase() === gw.address.toLowerCase())) {
        isMissingGlobals = true;
        break;
      }
    }

    if (isMissingGlobals) {
      for (const gw of GLOBAL_WALLETS) {
        if (!currentWallets.some(cw => cw.address.toLowerCase() === gw.address.toLowerCase())) {
          await supabase.from('wallets').insert({ 
            userId: user.id, 
            address: gw.address, 
            label: gw.label, 
            walletType: gw.walletType, 
            isActive: true, 
            alertsEnabled: true, 
            naorisBalance: 0, 
            ethBalance: 0, 
            lastActivityAt: null, 
            createdAt: Date.now(), 
            updatedAt: Date.now() 
          });
        }
      }
      const { data: updatedData } = await supabase.from('wallets').select('*').eq('userId', user.id);
      if (updatedData) currentWallets = updatedData as Wallet[];
    }
    
    setWallets(currentWallets);
  };

  useEffect(() => {
    if (!user) return;
    fetchWallets();
    const channel = supabase.channel('wallets-page').on('postgres_changes', { event: '*', schema: 'public', table: 'wallets', filter: `userId=eq.${user.id}` }, () => fetchWallets()).subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user]);

  const loadTransactionsForWallet = async (address: string) => {
    if (!user || walletTxs[address]) return;
    setLoadingTxs(prev => ({ ...prev, [address]: true }));
    
    // Fetch transactions where this address is either from or to
    const { data, error } = await supabase
      .from('transactions')
      .select('*')
      .eq('userId', user.id)
      .or(`fromAddress.ilike.${address},toAddress.ilike.${address}`)
      .order('timestamp', { ascending: false })
      .limit(5);

    if (!error && data) {
      setWalletTxs(prev => ({ ...prev, [address]: data as Transaction[] }));
    }
    setLoadingTxs(prev => ({ ...prev, [address]: false }));
  };

  const toggleExpand = (address: string) => {
    if (expandedWallet === address) {
      setExpandedWallet(null);
    } else {
      setExpandedWallet(address);
      loadTransactionsForWallet(address);
    }
  };

  const onSubmit = async (data: WalletForm) => {
    if (!user) return;
    try {
      const { error } = await supabase.from('wallets').insert({ userId: user.id, ...data, isActive: true, naorisBalance: 0, ethBalance: 0, lastActivityAt: null, createdAt: Date.now(), updatedAt: Date.now() });
      if (error) throw error;
      setIsModalOpen(false);
      reset();
    } catch (err) { handleSupabaseError(err, OperationType.CREATE, 'wallets'); }
  };

  const toggleWallet = async (id: string, current: boolean) => {
    try {
      const { error } = await supabase.from('wallets').update({ isActive: !current, updatedAt: Date.now() }).eq('id', id);
      if (error) throw error;
    } catch (err) { handleSupabaseError(err, OperationType.UPDATE, `wallets/${id}`); }
  };

  const deleteWallet = async (id: string) => {
    if (confirm('Are you sure you want to remove this wallet from monitoring?')) {
      try {
        const { error } = await supabase.from('wallets').delete().eq('id', id);
        if (error) throw error;
      } catch (err) { handleSupabaseError(err, OperationType.DELETE, `wallets/${id}`); }
    }
  };

  const filteredWallets = wallets.filter(w => w.label.toLowerCase().includes(searchTerm.toLowerCase()) || w.address.toLowerCase().includes(searchTerm.toLowerCase()));

  const getRiskBadge = (level: string) => {
    switch (level) {
      case 'Critical': return 'bg-red-500/10 text-red-500 border border-red-500/20';
      case 'High': return 'bg-orange-500/10 text-orange-500 border border-orange-500/20';
      case 'Medium': return 'bg-yellow-500/10 text-yellow-500 border border-yellow-500/20';
      default: return 'bg-blue-500/10 text-blue-500 border border-blue-500/20';
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex justify-between items-center">
        <div><h2 className="text-3xl font-bold tracking-tight">Wallet Watchlist</h2><p className="text-gray-400 mt-1">Manage entity addresses and live transaction tracking.</p></div>
        <div className="flex gap-3">
          <button onClick={() => setIsModalOpen(true)} className="px-4 py-2 bg-brand-primary text-black rounded-xl text-sm font-bold flex items-center gap-2 hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20"><Plus className="w-4 h-4" /> Add Wallet</button>
        </div>
      </header>

      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input type="text" placeholder="Search by label or address..." className="w-full bg-brand-card border border-white/10 rounded-2xl py-3 pl-11 pr-4 outline-none focus:border-brand-primary/50 transition-colors" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
      </div>

      <div className="bg-brand-card rounded-2xl border border-white/5 overflow-hidden">
        <table className="w-full text-left">
          <thead><tr className="border-b border-white/5 text-[10px] uppercase tracking-widest text-gray-500"><th className="px-4 py-4 w-10"></th><th className="px-6 py-4 font-bold">Label & Type</th><th className="px-6 py-4 font-bold">Address</th><th className="px-6 py-4 font-bold text-center">Status</th><th className="px-6 py-4 font-bold">NAORIS Balance</th><th className="px-6 py-4 font-bold">Last Activity</th><th className="px-6 py-4 font-bold text-right">Actions</th></tr></thead>
          <tbody className="divide-y divide-white/5">
            {filteredWallets.length === 0 ? (<tr><td colSpan={7} className="px-6 py-12 text-center text-gray-500">No wallets found matching your search.</td></tr>) : (
              filteredWallets.map(wallet => (
                <React.Fragment key={wallet.id}>
                  <tr className="hover:bg-white/[0.02] transition-colors group cursor-pointer" onClick={() => toggleExpand(wallet.address)}>
                    <td className="px-4 py-4 text-gray-500">
                      {expandedWallet === wallet.address ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                    </td>
                    <td className="px-6 py-4"><div className="flex items-center gap-3"><div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-gray-400 group-hover:text-brand-primary transition-colors"><Shield className="w-4 h-4" /></div><div><p className="text-sm font-bold">{wallet.label}</p><p className="text-[10px] text-gray-500 uppercase font-medium">{wallet.walletType}</p></div></div></td>
                    <td className="px-6 py-4"><div className="flex items-center gap-2" onClick={e => e.stopPropagation()}><code className="text-xs text-gray-400 font-mono">{formatAddress(wallet.address)}</code><a href={`https://sepolia.etherscan.io/address/${wallet.address}`} target="_blank" rel="noreferrer" className="text-gray-600 hover:text-blue-400 transition-colors"><ExternalLink className="w-3 h-3" /></a></div></td>
                    <td className="px-6 py-4" onClick={e => e.stopPropagation()}><div className="flex justify-center"><button onClick={() => toggleWallet(wallet.id, wallet.isActive)} className={cn("flex items-center gap-2 px-2 py-1 rounded-full text-[10px] font-bold uppercase transition-all", wallet.isActive ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20" : "bg-gray-500/10 text-gray-500 border border-gray-500/20")}>{wallet.isActive ? <ToggleRight className="w-3 h-3" /> : <ToggleLeft className="w-3 h-3" />}{wallet.isActive ? 'Active' : 'Paused'}</button></div></td>
                    <td className="px-6 py-4"><p className="text-sm font-black text-brand-primary">{formatNumber(Number(wallet.naorisBalance || 0))} N</p><p className="text-[10px] text-gray-500 font-mono">{Number(wallet.ethBalance || 0).toFixed(4)} Ξ</p></td>
                    <td className="px-6 py-4"><p className="text-xs text-gray-400">{wallet.lastActivityAt ? new Date(wallet.lastActivityAt).toLocaleDateString() : 'Never'}</p></td>
                    <td className="px-6 py-4 text-right" onClick={e => e.stopPropagation()}><button onClick={() => deleteWallet(wallet.id)} className="p-2 text-gray-600 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all opacity-0 group-hover:opacity-100"><Trash2 className="w-4 h-4" /></button></td>
                  </tr>
                  {/* Expanded Transaction Details */}
                  {expandedWallet === wallet.address && (
                    <tr className="bg-black/20">
                      <td colSpan={7} className="p-0">
                        <div className="px-14 py-6 border-l-2 border-brand-primary">
                          <div className="flex items-center justify-between mb-4">
                            <h4 className="text-sm font-bold flex items-center gap-2"><Activity className="w-4 h-4 text-brand-primary"/> Recent Activities</h4>
                            <span className="text-xs text-gray-500 italic">Real-time tracked</span>
                          </div>
                          
                          {loadingTxs[wallet.address] ? (
                            <div className="flex items-center justify-center py-4 text-gray-500 text-sm"><RefreshCw className="w-4 h-4 animate-spin mr-2" /> Loading latest activities...</div>
                          ) : walletTxs[wallet.address] && walletTxs[wallet.address].length > 0 ? (
                            <div className="bg-black/40 rounded-xl border border-white/5 overflow-hidden">
                              <table className="w-full text-left text-sm">
                                <thead>
                                  <tr className="border-b border-white/5 text-[10px] uppercase text-gray-500">
                                    <th className="px-4 py-3">Time</th>
                                    <th className="px-4 py-3">Type</th>
                                    <th className="px-4 py-3">Counterparty</th>
                                    <th className="px-4 py-3 text-right">Amount</th>
                                    <th className="px-4 py-3 text-center">Risk</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 font-mono">
                                  {walletTxs[wallet.address].map(tx => {
                                    const isOutbound = tx.fromAddress.toLowerCase() === wallet.address.toLowerCase();
                                    const counterparty = isOutbound ? tx.toAddress : tx.fromAddress;
                                    return (
                                      <tr key={tx.id} className="hover:bg-white/[0.02]">
                                        <td className="px-4 py-3 text-gray-400 text-xs">{new Date(tx.timestamp).toLocaleString()}</td>
                                        <td className="px-4 py-3">
                                          <div className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase", !isOutbound ? "text-emerald-500 bg-emerald-500/10" : "text-red-400 bg-red-400/10")}>
                                            {!isOutbound ? <ArrowDownLeft className="w-3 h-3" /> : <ArrowUpRight className="w-3 h-3" />}
                                            {!isOutbound ? 'Received' : 'Sent'}
                                          </div>
                                        </td>
                                        <td className="px-4 py-3 text-xs text-gray-300">
                                          <a href={`https://sepolia.etherscan.io/address/${counterparty}`} target="_blank" rel="noreferrer" className="hover:text-blue-400 flex items-center gap-1 transition-colors">
                                            {formatAddress(counterparty)} <ExternalLink className="w-3 h-3 text-gray-600"/>
                                          </a>
                                        </td>
                                        <td className="px-4 py-3 text-right font-bold text-gray-100">{tx.amountFormatted.toLocaleString()} N</td>
                                        <td className="px-4 py-3">
                                          <div className="flex justify-center">
                                            <span className={cn("px-2 py-0.5 rounded text-[10px] font-bold uppercase", getRiskBadge(tx.riskLevel))}>{tx.riskLevel}</span>
                                          </div>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          ) : (
                            <div className="text-center py-6 text-sm text-gray-500 bg-black/20 rounded-xl border border-white/5">
                              No recent transactions detected for this wallet.
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-brand-card w-full max-w-md rounded-2xl border border-white/10 shadow-2xl overflow-hidden">
            <div className="p-6 border-b border-white/5 flex justify-between items-center bg-white/5"><h3 className="font-bold text-lg">Add New Wallet</h3><button onClick={() => setIsModalOpen(false)} className="p-1 hover:bg-white/10 rounded-full transition-colors"><X className="w-5 h-5" /></button></div>
            <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
              <div className="space-y-1.5"><label className="text-xs font-bold text-gray-500 uppercase">Address</label><input {...register('address')} placeholder="0x..." className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 outline-none focus:border-brand-primary/50 transition-all font-mono text-sm" />{errors.address && <p className="text-[10px] text-red-500 font-bold">{errors.address.message}</p>}</div>
              <div className="space-y-1.5"><label className="text-xs font-bold text-gray-500 uppercase">Label</label><input {...register('label')} placeholder="e.g. NAORIS Treasury" className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 outline-none focus:border-brand-primary/50 transition-all text-sm" />{errors.label && <p className="text-[10px] text-red-500 font-bold">{errors.label.message}</p>}</div>
              <div className="space-y-1.5"><label className="text-xs font-bold text-gray-500 uppercase">Classification</label><select {...register('walletType')} className="w-full bg-black/40 border border-white/10 rounded-xl py-3 px-4 outline-none focus:border-brand-primary/50 transition-all text-sm appearance-none">{Object.values(WalletType).map(type => (<option key={type} value={type} className="bg-brand-card">{type}</option>))}</select></div>
              <div className="flex items-center gap-3 py-2"><input type="checkbox" {...register('alertsEnabled')} className="w-4 h-4 accent-brand-primary" /><label className="text-sm text-gray-300">Enable real-time alerts</label></div>
              <div className="pt-4"><button type="submit" className="w-full py-3 bg-brand-primary text-black font-black rounded-xl hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20">START MONITORING</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

