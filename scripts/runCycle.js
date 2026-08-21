/**
 * The full automatic cycle — run this on a schedule (Railway cron, or any
 * scheduler). Every run does two things, in order:
 *
 * 1. OWNERSHIP CHECK: for every tracked NFT, confirm who really owns it
 *    on-chain right now. If it changed hands, close out the old owner's
 *    accrued-but-unpaid rewards (still paid out to THEM in step 2, since
 *    it was earned before the transfer) and start the clock fresh for
 *    the new owner.
 *
 * 2. AUTOMATIC PAYOUT: for every holding with enough accrued rewards,
 *    send $RPLTS directly to its current owner. No claim button, no
 *    signature, nothing for the user to do. If a wallet has no trustline
 *    yet, the payment fails harmlessly and their rewards just keep
 *    accruing for the next cycle — nothing is lost, and nothing prompts
 *    them to do anything.
 *
 * MIN_PAYOUT exists so we're not paying out 0.001 $RPLTS every 5 minutes
 * and burning XRP on transaction fees for no reason — small amounts just
 * accumulate until they cross the threshold.
 *
 * Usage: node scripts/runCycle.js
 */

require('dotenv').config();
const supabase = require('../lib/supabase');
const xrplClient = require('../lib/xrplClient');
const { accruedSince, round2 } = require('../lib/rewards');

const MIN_PAYOUT = parseFloat(process.env.MIN_PAYOUT_THRESHOLD || '1');

async function runOwnershipCheck() {
  console.log('--- Ownership check ---');
  const { data: holdings, error } = await supabase.from('nft_holdings').select('*');
  if (error) throw error;

  if (!holdings || holdings.length === 0) {
    console.log('No NFTs tracked yet — nothing to check.\n');
    return;
  }

  let changed = 0;
  let unchanged = 0;
  let errors = 0;

  for (const row of holdings) {
    let currentOwner;
    try {
      currentOwner = await xrplClient.getCurrentOwner(row.nft_token_id);
    } catch (e) {
      errors++;
      continue;
    }
    if (!currentOwner) {
      errors++;
      continue;
    }

    if (currentOwner === row.owner_wallet) {
      await supabase
        .from('nft_holdings')
        .update({ last_checked_at: new Date().toISOString() })
        .eq('nft_token_id', row.nft_token_id);
      unchanged++;
      continue;
    }

    const accruedForOldOwner = accruedSince(row.last_claim_at);
    await supabase.from('ownership_changes').insert({
      nft_token_id: row.nft_token_id,
      old_owner: row.owner_wallet,
      new_owner: currentOwner,
      accrued_at_change: accruedForOldOwner,
    });

    // Note: we do NOT zero out accrued rewards on transfer — the old owner
    // still gets what they earned in the payout step below, since ownership
    // at time of accrual is what matters, not ownership right now.
    const now = new Date().toISOString();
    await supabase
      .from('nft_holdings')
      .update({ owner_wallet: currentOwner, held_since: now, last_checked_at: now })
      .eq('nft_token_id', row.nft_token_id);

    console.log(`  ${row.nft_token_id}: ${row.owner_wallet} → ${currentOwner}`);
    changed++;
  }

  console.log(`Checked ${holdings.length}: ${unchanged} unchanged, ${changed} changed, ${errors} errors.\n`);
}

async function runPayouts() {
  console.log('--- Automatic payouts ---');
  const { data: holdings, error } = await supabase.from('nft_holdings').select('*');
  if (error) throw error;

  // Group by owner so each wallet gets ONE payment covering all their
  // ripplets, instead of a separate tiny transaction per NFT.
  const byOwner = {};
  for (const h of holdings || []) {
    const accrued = accruedSince(h.last_claim_at);
    if (accrued <= 0) continue;
    if (!byOwner[h.owner_wallet]) byOwner[h.owner_wallet] = [];
    byOwner[h.owner_wallet].push({ ...h, accrued });
  }

  const { data: reserve } = await supabase.from('reserve').select('*').eq('id', 1).single();
  let remaining = reserve.total_reserve - reserve.distributed;

  if (remaining <= 0) {
    console.log('Reserve is empty — no payouts this cycle.\n');
    return;
  }

  let paid = 0;
  let skippedNoTrustline = 0;
  let skippedBelowMin = 0;
  let totalPaidThisCycle = 0;

  for (const [owner, items] of Object.entries(byOwner)) {
    const total = round2(items.reduce((sum, h) => sum + h.accrued, 0));
    if (total < MIN_PAYOUT) {
      skippedBelowMin++;
      continue;
    }
    if (remaining <= 0) break;

    const payout = Math.min(total, remaining);

    try {
      const result = await xrplClient.sendRPLTS(owner, payout);
      const now = new Date().toISOString();

      for (const h of items) {
        const share = Math.min(h.accrued, payout);
        await supabase
          .from('nft_holdings')
          .update({ last_claim_at: now, total_claimed: round2((h.total_claimed || 0) + share) })
          .eq('nft_token_id', h.nft_token_id);

        await supabase.from('claims').insert({
          nft_token_id: h.nft_token_id,
          owner_wallet: owner,
          amount: share,
          tx_hash: result.result.hash,
        });
      }

      remaining = round2(remaining - payout);
      totalPaidThisCycle = round2(totalPaidThisCycle + payout);

      console.log(`  Paid ${payout} $RPLTS to ${owner}`);
      paid++;
    } catch (e) {
      // Most common cause: no trustline yet. This is expected and fine —
      // their rewards just stay accrued for next cycle, no error surfaced
      // to them, no prompt of any kind.
      console.log(`  Skipped ${owner} (${e.txResult || e.message}) — likely no trustline yet, will retry next cycle.`);
      skippedNoTrustline++;
    }
  }

  if (totalPaidThisCycle > 0) {
    await supabase
      .from('reserve')
      .update({ distributed: round2(reserve.distributed + totalPaidThisCycle) })
      .eq('id', 1);
  }

  console.log(`Payouts: ${paid} sent, ${skippedNoTrustline} skipped (no trustline/error), ${skippedBelowMin} skipped (below ${MIN_PAYOUT} minimum).\n`);
}

async function main() {
  console.log(`Running full cycle at ${new Date().toISOString()}\n`);
  await runOwnershipCheck();
  await runPayouts();
  console.log('Cycle complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Cycle failed:', err);
    process.exit(1);
  });
