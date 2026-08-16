-- Ripplets staking schema
-- Run this in Supabase SQL Editor once.

create table if not exists stakes (
  id uuid primary key default gen_random_uuid(),
  nft_token_id text not null unique,       -- XRPL NFTokenID
  owner_wallet text not null,               -- classic address of the staker
  staked_at timestamptz not null default now(),
  unlock_at timestamptz not null,           -- staked_at + 7 days
  status text not null default 'staked',    -- 'staked' | 'unstaked'
  last_claim_at timestamptz not null default now(), -- resets accrual counter on claim
  total_claimed numeric not null default 0, -- lifetime $RPLTS claimed for this stake
  unstaked_at timestamptz
);

create index if not exists idx_stakes_owner on stakes(owner_wallet);
create index if not exists idx_stakes_status on stakes(status);

-- One row, tracks the whole reward reserve so the API can refuse claims
-- once it's dry instead of overdrawing.
create table if not exists reserve (
  id int primary key default 1,
  total_reserve numeric not null default 500000,   -- 5% of 10,000,000 supply
  distributed numeric not null default 0,
  constraint single_row check (id = 1)
);

insert into reserve (id, total_reserve, distributed)
values (1, 500000, 0)
on conflict (id) do nothing;

-- Every claim gets logged here for the "receipts" transparency page.
create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  stake_id uuid references stakes(id),
  owner_wallet text not null,
  amount numeric not null,
  tx_hash text,
  claimed_at timestamptz not null default now()
);

