# Ripplets staking backend

Node.js + Express API handling NFT staking, $RPLTS reward accrual, and
claims — matches your existing stack (Railway, Supabase, XRPL, Xaman).

## How staking actually works on XRPL (no smart contracts)

XRPL doesn't have smart contracts, so "staking" is really: the NFT gets
transferred into a project-controlled wallet for the lock period, and
Supabase tracks who owns what and since when.

**Stake:**
1. User's wallet creates a zero-cost NFT sell offer with `Destination` set
   to the project wallet (`POST /api/stake/request` gives you the Xaman
   payload for this)
2. Project wallet auto-accepts that offer, taking custody
   (`POST /api/stake/confirm` does this server-side once the user has signed)
3. Supabase logs the stake with a timestamp and a 7-day unlock date

**Rewards:**
- Computed live, not via a background job — `accrued = days_since_last_claim × 10`
- `GET /api/rewards/:wallet` shows current accrued total across all their staked ripplets
- `POST /api/claim` pays out everything accrued in one Payment transaction,
  checks the reserve isn't dry first

**Unstake (after the 7-day lock):**
1. Project wallet creates a zero-cost return offer back to the original owner
2. User signs accepting it in Xaman — NFT is back in their wallet
3. Supabase marks the stake as closed

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- **Supabase**: create a project, run `schema.sql` in the SQL editor, grab
  the URL + service role key from Project Settings → API
- **Xaman**: register an app at apps.xumm.dev, grab the API key + secret
- **Project wallet**: a fresh XRPL wallet (Xumm app or `xrpl.js` can generate
  one) that will hold staked NFTs and pay out rewards — fund it with some
  XRP for reserve requirements + tx fees. Keep the seed secret, only in env vars.
- **$RPLTS issuer**: the wallet address that issued your $RPLTS token
  (probably the same wallet you used to mint the initial 10,000,000 supply)

```bash
npm start
```

Deploy the same way as your other bots — push to GitHub, connect the repo
in Railway, add the same env vars there.

## Important: trustlines

XRPL requires a wallet to explicitly "trust" an issued currency before it
can receive it. Your frontend needs to check if a wallet has a $RPLTS
trustline before their first claim — if not, prompt `createTrustlineRequest`
from `lib/xumm.js` first. Otherwise their first claim will just fail (the
API returns a clear error message for this case, but it's better to check
and prompt proactively in the UI).

## Endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/api/auth/signin` | Start wallet connect (Xaman sign-in) |
| GET | `/api/auth/signin/:uuid` | Poll sign-in result |
| POST | `/api/stake/request` | Get Xaman payload to stake an NFT |
| POST | `/api/stake/confirm` | Confirm + finalize a stake after signing |
| POST | `/api/unstake/request` | Get Xaman payload to unstake (after lock) |
| POST | `/api/unstake/confirm` | Confirm + finalize an unstake |
| GET | `/api/rewards/:wallet` | Live accrued rewards for a wallet |
| POST | `/api/claim` | Claim all accrued $RPLTS |
| GET | `/api/stats` | Public stats — staked count, reserve remaining |

## Honest limitations to know about

- **Not audited.** This is a working first pass, not something to put
  significant funds behind without a security review — especially the hot
  wallet holding both custody of NFTs and the reward reserve.
- **Single point of failure**: the project wallet's seed controls everything.
  If it's compromised, both staked NFTs and the reserve are at risk. Consider
  a multisig setup before real funds are involved.
- **No rate limiting yet** — add it before this is public-facing (the `claim`
  endpoint especially, so it can't be hammered).

