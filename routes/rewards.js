const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const xrplClient = require('../lib/xrplClient');
const { accruedSince, round2 } = require('../lib/rewards');

// What a wallet can see: their staked ripplets + live accrued rewards on each,
// plus their lifetime total (including past unstaked ripplets, so history
// isn't lost once something's unstaked).
router.get('/rewards/:wallet', async (req, res) => {
  const { wallet } = req.params;

  const { data: activeStakes, error } = await supabase
    .from('stakes')
    .select('*')
    .eq('owner_wallet', wallet)
    .eq('status', 'staked');
  if (error) return res.status(500).json({ error: 'Failed to load stakes.' });

  const { data: allStakes, error: allErr } = await supabase
    .from('stakes')
    .select('total_claimed')
    .eq('owner_wallet', wallet);
  if (allErr) return res.status(500).json({ error: 'Failed to load claim history.' });

  const withRewards = activeStakes.map((s) => ({
    nftTokenId: s.nft_token_id,
    stakedAt: s.staked_at,
    unlockAt: s.unlock_at,
    accrued: accruedSince(s.last_claim_at),
    totalClaimed: s.total_claimed,
  }));

  const totalAccrued = round2(withRewards.reduce((sum, s) => sum + s.accrued, 0));
  const lifetimeClaimed = round2((allStakes || []).reduce((sum, s) => sum + (s.total_claimed || 0), 0));

  res.json({ stakes: withRewards, totalAccrued, lifetimeClaimed });
});

// Claim everything accrued across all of a wallet's staked ripplets in one
// on-chain payment, checking the reserve isn't dry first.
router.post('/claim', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet is required.' });

  const { data: stakes, error } = await supabase
    .from('stakes')
    .select('*')
    .eq('owner_wallet', wallet)
    .eq('status', 'staked');
  if (error) return res.status(500).json({ error: 'Failed to load stakes.' });

  const claimable = stakes
    .map((s) => ({ ...s, accrued: accruedSince(s.last_claim_at) }))
    .filter((s) => s.accrued > 0);

  const total = round2(claimable.reduce((sum, s) => sum + s.accrued, 0));
  if (total <= 0) {
    return res.status(400).json({ error: 'Nothing to claim yet.' });
  }

  const { data: reserve } = await supabase.from('reserve').select('*').eq('id', 1).single();
  const remaining = reserve.total_reserve - reserve.distributed;
  if (total > remaining) {
    // Reserve nearly dry — pay out what's left rather than failing outright,
    // so the last claimants aren't just stuck. Flag this loudly to the frontend.
    if (remaining <= 0) {
      return res.status(409).json({ error: 'Staking reserve is empty. Rewards paused until fee-funding kicks in.' });
    }
  }
  const payout = Math.min(total, remaining);

  try {
    const txResult = await xrplClient.sendRPLTS(wallet, payout);
    const txHash = txResult.result.hash;

    const now = new Date().toISOString();
    for (const s of claimable) {
      await supabase
        .from('stakes')
        .update({
          last_claim_at: now,
          total_claimed: round2(s.total_claimed + Math.min(s.accrued, payout)),
        })
        .eq('id', s.id);

      await supabase.from('claims').insert({
        stake_id: s.id,
        owner_wallet: wallet,
        amount: s.accrued,
        tx_hash: txHash,
      });
    }

    await supabase
      .from('reserve')
      .update({ distributed: round2(reserve.distributed + payout) })
      .eq('id', 1);

    res.json({ status: 'claimed', amount: payout, txHash });
  } catch (err) {
    console.error(err);
    // Common failure: user has no trustline for $RPLTS yet.
    res.status(500).json({
      error: 'Claim failed — if this is your first claim, make sure you\'ve set a trustline for $RPLTS first.',
    });
  }
});

// Public transparency numbers for the site's stats row.
router.get('/stats', async (req, res) => {
  const { data: reserve } = await supabase.from('reserve').select('*').eq('id', 1).single();
  const { count: stakedCount } = await supabase
    .from('stakes')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'staked');

  res.json({
    stakedCount: stakedCount || 0,
    totalSupply: 100,
    reserveRemaining: round2(reserve.total_reserve - reserve.distributed),
    reserveTotal: reserve.total_reserve,
    totalDistributed: round2(reserve.distributed),
  });
});

module.exports = router;
