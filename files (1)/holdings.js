const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const xrplClient = require('../lib/xrplClient');
const { accruedSince, round2 } = require('../lib/rewards');

// Pure read — no signature required, ever. Anyone can check any wallet,
// since this is all public blockchain + reward data. Rewards shown here
// as "accrued" are paid out automatically by the scheduled cycle job —
// there's no claim button, nothing to sign.
router.get('/holdings/:wallet', async (req, res) => {
  const { wallet } = req.params;

  const { data: holdings, error } = await supabase
    .from('nft_holdings')
    .select('*')
    .eq('owner_wallet', wallet);
  if (error) return res.status(500).json({ error: 'Failed to load holdings.' });

  const withRewards = (holdings || []).map((h) => ({
    nftTokenId: h.nft_token_id,
    heldSince: h.held_since,
    accrued: accruedSince(h.last_claim_at),
    totalClaimed: h.total_claimed,
  }));

  const totalAccrued = round2(withRewards.reduce((sum, h) => sum + h.accrued, 0));
  const lifetimePaid = round2(withRewards.reduce((sum, h) => sum + (h.totalClaimed || 0), 0));

  let hasTrustline = null;
  try {
    hasTrustline = await xrplClient.hasTrustline(wallet);
  } catch (e) {
    // If the address is unfunded/invalid, this can fail — not fatal,
    // just leave hasTrustline as null so the frontend can show a neutral state.
  }

  res.json({ holdings: withRewards, totalAccrued, lifetimePaid, hasTrustline });
});

// Public transparency stats.
router.get('/stats', async (req, res) => {
  const { data: reserve } = await supabase.from('reserve').select('*').eq('id', 1).single();
  const { count: totalTracked } = await supabase
    .from('nft_holdings')
    .select('*', { count: 'exact', head: true });

  res.json({
    trackedCount: totalTracked || 0,
    totalSupply: 100,
    reserveRemaining: round2(reserve.total_reserve - reserve.distributed),
    reserveTotal: reserve.total_reserve,
    totalDistributed: round2(reserve.distributed),
  });
});

module.exports = router;
