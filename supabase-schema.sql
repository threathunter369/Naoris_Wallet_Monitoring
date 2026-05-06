-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- Wallets Table
create table if not exists public.wallets (
    id uuid default uuid_generate_v4() primary key,
    "userId" uuid references auth.users(id) on delete cascade not null,
    address text not null,
    label text not null,
    "walletType" text not null,
    "isActive" boolean default true,
    "alertsEnabled" boolean default true,
    "naorisBalance" numeric default 0,
    "ethBalance" numeric default 0,
    "lastActivityAt" bigint,
    "createdAt" bigint not null,
    "updatedAt" bigint not null
);

-- Transactions Table
create table if not exists public.transactions (
    id text primary key,
    "userId" uuid references auth.users(id) on delete cascade not null,
    "txHash" text not null,
    "blockNumber" integer not null,
    timestamp bigint not null,
    "fromAddress" text not null,
    "toAddress" text not null,
    "amountRaw" text not null,
    "amountFormatted" numeric not null,
    "percentTotalSupply" numeric not null,
    "tokenContract" text not null,
    direction text not null,
    "riskLevel" text not null,
    status text not null,
    "usdValue" numeric,
    "walletLabel" text
);

-- Alerts Table
create table if not exists public.alerts (
    id uuid default uuid_generate_v4() primary key,
    "userId" uuid references auth.users(id) on delete cascade not null,
    "alertType" text not null,
    severity text not null,
    "walletAddress" text not null,
    "walletLabel" text not null,
    "txHash" text,
    amount numeric not null,
    reason text not null,
    "recommendedAction" text not null,
    status text not null default 'New',
    "createdAt" bigint not null,
    "blockNumber" integer,
    "gasUsed" text,
    "gasPrice" text,
    "networkHealth" text
);

-- Alert Rules Table
create table if not exists public."alertRules" (
    id uuid default uuid_generate_v4() primary key,
    "userId" uuid references auth.users(id) on delete cascade not null,
    name text not null,
    description text not null,
    "ruleType" text not null,
    threshold numeric not null,
    comparison text not null,
    severity text not null,
    "isActive" boolean default true,
    "targetWalletId" text,
    "createdAt" bigint not null,
    "updatedAt" bigint not null
);

-- Settings Table
create table if not exists public.settings (
    id uuid references auth.users(id) on delete cascade primary key,
    "userId" uuid references auth.users(id) on delete cascade not null,
    "inApp" boolean default true,
    email jsonb default '{"enabled": false, "recipient": ""}'::jsonb,
    telegram jsonb default '{"enabled": false, "chatId": ""}'::jsonb,
    discord jsonb default '{"enabled": false, "webhookUrl": ""}'::jsonb,
    "minSeverity" text default 'Medium',
    "updatedAt" timestamp with time zone default now()
);

-- Sync Table
create table if not exists public.sync (
    id text primary key,
    "lastBlock" integer not null,
    "updatedAt" bigint not null
);

-- Enable RLS (Row Level Security)
alter table public.wallets enable row level security;
alter table public.transactions enable row level security;
alter table public.alerts enable row level security;
alter table public."alertRules" enable row level security;
alter table public.settings enable row level security;
alter table public.sync enable row level security;

-- Create Policies (Safely drop them first if they exist to prevent errors, or just use DO block, but IF NOT EXISTS is cleaner for Postgres 12+)
-- Since Supabase uses Postgres 15+, we can just create them. If they exist it'll throw a minor warning, but it's safe.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Users can manage their own wallets') THEN
    create policy "Users can manage their own wallets" on public.wallets for all using (auth.uid() = "userId");
    create policy "Users can manage their own transactions" on public.transactions for all using (auth.uid() = "userId");
    create policy "Users can manage their own alerts" on public.alerts for all using (auth.uid() = "userId");
    create policy "Users can manage their own alert rules" on public."alertRules" for all using (auth.uid() = "userId");
    create policy "Users can manage their own settings" on public.settings for all using (auth.uid() = "userId");
    create policy "Anyone can read sync" on public.sync for select using (true);
  END IF;
END $$;

-- Set Replica Identity to FULL so that UPDATE operations include all columns in the realtime payload.
-- This is critical for `userId=eq.${user.id}` filters to work on updates!
alter table public.wallets replica identity full;
alter table public.transactions replica identity full;
alter table public.alerts replica identity full;
alter table public."alertRules" replica identity full;

-- Enable Realtime
DO $$
BEGIN
  -- We use a DO block to catch the error if the tables are already in the publication
  ALTER PUBLICATION supabase_realtime ADD TABLE public.wallets;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public."alertRules";
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
