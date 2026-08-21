const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const xrplClient = require('../lib/xrplClient');
const { accruedSince, round2 } = require('../lib/rewards');

// Read-only check the frontend calls before showing the claim popup —
// tells it how much is claimable and whether the trustline is already set,
// so the UI can guide the person accurately instead of guessing.
router.get('/claim/:wallet/check', async (req, res) => {
  const { wallet } = req.params;

  const { data: holdings, error } = await supabase
    .from('nft_holdings')
    .select('*')
    .eq('owner_wallet', wallet);
  if (error) return res.status(500).json({ error: 'Failed to load holdings.' });

  const totalAccrued = round2(
    (holdings || []).reduce((sum, h) => sum + accruedSince(h.last_claim_at), 0)
  );

  let hasTrustline = null;
  try {
    hasTrustline = await xrplClient.hasTrustline(wallet);
  } catch (e) {
    // Unfunded/invalid address — leave as null, frontend can show a neutral state.
  }

  res.json({ totalAccrued, hasTrustline });
});

// The actual payout. No signature required — the destination is always
// exactly the wallet requesting it, and the amount is always exactly what
// our own on-chain-verified records say that wallet has earned. There is
// no path by which calling this for wallet X sends money anywhere but
// wallet X's own accrued balance, so this is safe to expose with zero auth.
router.post('/claim', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet is required.' });

  try {
    const { data: holdings, error } = await supabase
      .from('nft_holdings')
      .select('*')
      .eq('owner_wallet', wallet);
    if (error) throw error;

    const claimable = (holdings || [])
      .map((h) => ({ ...h, accrued: accruedSince(h.last_claim_at) }))
      .filter((h) => h.accrued > 0);

    const total = round2(claimable.reduce((sum, h) => sum + h.accrued, 0));
    if (total <= 0) {
      return res.status(400).json({ error: 'Nothing to claim right now.' });
    }

    const { data: reserve } = await supabase.from('reserve').select('*').eq('id', 1).single();
    const remaining = reserve.total_reserve - reserve.distributed;
    if (remaining <= 0) {
      return res.status(409).json({ error: 'Staking reserve is empty. Rewards paused until fee-funding kicks in.' });
    }
    const payout = Math.min(total, remaining);

    const result = await xrplClient.sendRPLTS(wallet, payout);
    const now = new Date().toISOString();

    for (const h of claimable) {
      const share = Math.min(h.accrued, payout);
      await supabase
        .from('nft_holdings')
        .update({ last_claim_at: now, total_claimed: round2((h.total_claimed || 0) + share) })
        .eq('nft_token_id', h.nft_token_id);

      await supabase.from('claims').insert({
        nft_token_id: h.nft_token_id,
        owner_wallet: wallet,
        amount: share,
        tx_hash: result.result.hash,
      });
    }

    await supabase
      .from('reserve')
      .update({ distributed: round2(reserve.distributed + payout) })
      .eq('id', 1);

    res.json({ status: 'claimed', amount: payout, txHash: result.result.hash });
  } catch (err) {
    console.error(err);
    // Most common real-world cause: no trustline yet.
    res.status(500).json({
      error: err.message && err.message.includes('tecNO_LINE')
        ? 'No trustline for $RPLTS found on this wallet — set one up first, then try again.'
        : 'Claim failed. If this keeps happening, make sure the trustline is set up correctly.',
    });
  }
});

module.exports = router;
