# Ripplets backend — hold-to-earn (v2)

**No wallet signing anywhere in this app.** The site is 100% read-only —
paste any address to see what Ripplets it holds and what it's earned.
Rewards are paid out automatically by a scheduled job, directly to whoever
actually owns each NFT on-chain. Nothing to click, nothing to sign, nothing
that could ever trigger Xaman's "is someone promising you free crypto?"
warning, because this app never sends a single sign request.

## Why this is safe (the actual security reasoning)

The one thing you might worry about: "if it's automatic, can someone
redirect someone else's rewards to themselves by typing in their address?"

No — because the **payout destination is never something a user submits**.
It's decided entirely by `getCurrentOwner()` in `lib/xrplClient.js`, which
asks the XRP Ledger directly "who really owns this NFT right now?" A
scammer can view any address's public holdings, same as anyone can look up
any wallet on xrpscan.com, but that has zero effect on where money goes.

## How it works

**Every 5-10 minutes** (however often you schedule `scripts/runCycle.js`):

1. **Ownership check** — for every tracked NFT, ask the ledger who owns it
   right now. If it changed hands, the old owner's earned-but-unpaid
   rewards are preserved (they still get paid what they earned), and the
   clock resets for the new owner.
2. **Automatic payout** — anyone with enough accrued $RPLTS gets it sent
   directly, no action needed. If their wallet has no trustline for
   $RPLTS yet, the payment just fails harmlessly and their rewards sit
   safely accrued for the next cycle — no error shown to them, no prompt.

**Discovery is lazy and organic**: an NFT only starts earning once someone
checks that wallet on the site (`GET /api/wallet/:address/ripplets`), which
registers it. This also means the site itself doubles as a way to
instantly reconcile a stale ownership record, not just the scheduled job.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`: Supabase keys, your project wallet's mnemonic/seed, and
(once you've minted) your Ripplets NFT issuer address.

Run the schema in Supabase SQL Editor: `schema.sql`

```bash
npm start          # the read-only API
npm run cycle       # run one ownership-check + payout cycle manually
```

## Deploying the cycle job

`npm run cycle` needs to run on a schedule — this is the part that actually
distributes rewards. On Railway: add a second service pointing at this same
repo, set its start command to `node scripts/runCycle.js`, and use Railway's
Cron Schedule feature (e.g. `*/5 * * * *` for every 5 minutes). It needs the
same environment variables as the main API service.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/api/wallet/:address/ripplets` | Discover + register a wallet's Ripplets (read-only) |
| GET | `/api/holdings/:wallet` | Accrued + paid rewards for a wallet (read-only) |
| GET | `/api/nft/:id/metadata` | Real image/name for one NFT |
| GET | `/api/stats` | Public transparency numbers |

Nothing here requires or triggers a wallet signature. That's the whole point.

## Honest limitations

- **Snapshot precision**: ownership is checked periodically, not
  instantly. A very fast buy-then-sell faster than your cycle interval
  might not be perfectly captured. Not a security issue, just a precision
  trade-off — shorten the interval if this matters more than RPC cost.
- **Reserve math is enforced in code, not on-chain** — same caveat as
  before. The project wallet's mnemonic is the single point of control
  over both the token supply and every payout. Protect it accordingly,
  and consider a proper key-management setup (not just a `.env` file)
  before this holds real value at scale.
- **Trustline is entirely the holder's own responsibility** — the app
  never prompts for one. Worth explaining this clearly in your site copy
  so people know they need one to actually receive anything.
