-- Ripplets hold-to-earn schema (v2) — replaces the old stake/unstake model.
-- Run this in Supabase SQL Editor.
--
-- If migrating from the old schema, you can drop the old tables first:
--   drop table if exists claims;
--   drop table if exists stakes;
-- (reserve table is reused as-is, no change needed there)

create table if not exists nft_holdings (
  nft_token_id text primary key,      -- XRPL NFTokenID
  owner_wallet text not null,          -- whoever currently holds it
  held_since timestamptz not null default now(),   -- resets whenever ownership changes
  last_claim_at timestamptz not null default now(), -- resets whenever this owner claims
  total_claimed numeric not null default 0,         -- lifetime, follows the NFT across owners
  last_checked_at timestamptz not null default now() -- when the snapshot job last confirmed this
);

create index if not exists idx_holdings_owner on nft_holdings(owner_wallet);

-- Reserve table — same as before, reused unchanged.
create table if not exists reserve (
  id int primary key default 1,
  total_reserve numeric not null default 500000,
  distributed numeric not null default 0,
  constraint single_row check (id = 1)
);

insert into reserve (id, total_reserve, distributed)
values (1, 500000, 0)
on conflict (id) do nothing;

-- Every claim logged here for the transparency page.
create table if not exists claims (
  id uuid primary key default gen_random_uuid(),
  nft_token_id text,
  owner_wallet text not null,
  amount numeric not null,
  tx_hash text,
  claimed_at timestamptz not null default now()
);

-- Log of ownership changes the snapshot job detects — useful for debugging
-- and for showing "this ripplet has had 3 owners" type history later.
create table if not exists ownership_changes (
  id uuid primary key default gen_random_uuid(),
  nft_token_id text not null,
  old_owner text,
  new_owner text not null,
  accrued_at_change numeric not null default 0,  -- what the old owner had earned but not claimed
  changed_at timestamptz not null default now()
);
