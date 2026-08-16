const express = require('express');
const router = express.Router();
const supabase = require('../lib/supabase');
const xumm = require('../lib/xumm');
const xrplClient = require('../lib/xrplClient');
const { unlockDate, accruedSince, round2 } = require('../lib/rewards');

const PROJECT_WALLET_ADDRESS = process.env.PROJECT_WALLET_ADDRESS;

// Step 1: frontend calls this to get a Xaman payload the user signs,
// creating a zero-cost sell offer to the project wallet.
router.post('/stake/request', async (req, res) => {
  const { nftTokenId, ownerAddress } = req.body;
  if (!nftTokenId || !ownerAddress) {
    return res.status(400).json({ error: 'nftTokenId and ownerAddress are required.' });
  }

  const { data: existing } = await supabase
    .from('stakes')
    .select('id')
    .eq('nft_token_id', nftTokenId)
    .eq('status', 'staked')
    .maybeSingle();
  if (existing) {
    return res.status(409).json({ error: 'This ripplet is already staked.' });
  }

  try {
    const request = await xumm.createStakeOfferRequest(nftTokenId, ownerAddress, PROJECT_WALLET_ADDRESS);
    res.json(request);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create stake request.' });
  }
});

// Step 2: frontend polls this after the user signs. Once signed, this
// endpoint has the project wallet accept the offer (taking custody) and
// writes the stake row.
router.post('/stake/confirm', async (req, res) => {
  const { uuid, nftTokenId, ownerAddress } = req.body;

  try {
    const result = await xumm.getPayloadResult(uuid);
    if (!result.signed) {
      return res.status(202).json({ status: 'pending' });
    }

    // The signed tx created an offer — we need its ledger index to accept it.
    // Simplest reliable way: look up the NFT's current sell offers on-chain.
    const client = await xrplClient.getClient();
    const offers = await client.request({
      command: 'nft_sell_offers',
      nft_id: nftTokenId,
    }).catch(() => ({ result: { offers: [] } }));

    const offer = (offers.result.offers || []).find(
      (o) => o.destination === PROJECT_WALLET_ADDRESS
    );
    if (!offer) {
      return res.status(400).json({ error: 'No matching offer found on-chain yet, try again shortly.' });
    }

    await xrplClient.acceptNFTOffer(offer.nft_offer_index);

    const stakedAt = new Date();
    const { error } = await supabase.from('stakes').upsert({
      nft_token_id: nftTokenId,
      owner_wallet: ownerAddress,
      staked_at: stakedAt.toISOString(),
      unlock_at: unlockDate(stakedAt).toISOString(),
      last_claim_at: stakedAt.toISOString(),
      status: 'staked',
      unstaked_at: null,
    }, { onConflict: 'nft_token_id' });
    if (error) throw error;

    res.json({ status: 'staked', unlockAt: unlockDate(stakedAt) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm stake.' });
  }
});

// Unstake: no lock — anyone can unstake anytime. Trust matters more than
// forcing a hold period, especially early on. Project wallet creates a
// return offer immediately whenever someone asks for it back.
router.post('/unstake/request', async (req, res) => {
  const { nftTokenId } = req.body;

  const { data: stake } = await supabase
    .from('stakes')
    .select('*')
    .eq('nft_token_id', nftTokenId)
    .eq('status', 'staked')
    .maybeSingle();

  if (!stake) return res.status(404).json({ error: 'No active stake found for this ripplet.' });

  try {
    // If the user cancelled a previous unstake attempt (or retried before
    // this resolved), a return offer for this NFT to this owner may already
    // be sitting on-chain. Reuse it instead of submitting a duplicate
    // NFTokenCreateOffer every time this endpoint is hit — that's what was
    // causing stale-sequence errors on retry.
    const client = await xrplClient.getClient();
    const existingOffers = await client.request({
      command: 'nft_sell_offers',
      nft_id: nftTokenId,
    }).catch(() => ({ result: { offers: [] } }));

    let offerIndex = (existingOffers.result.offers || []).find(
      (o) => o.destination === stake.owner_wallet
    )?.nft_offer_index;

    if (!offerIndex) {
      try {
        const created = await xrplClient.createReturnOffer(nftTokenId, stake.owner_wallet);
        offerIndex = created.offerIndex;
      } catch (chainErr) {
        // tecNO_ENTRY on this specific tx means the project wallet doesn't
        // currently hold the NFT it's trying to make an offer for. That
        // usually means it's already back with the owner from an earlier
        // attempt that succeeded on-chain but never reached
        // /unstake/confirm (e.g. the server crashed right after). Self-heal
        // the stale DB row instead of failing forever.
        const resultCode = chainErr.xrplResult && chainErr.xrplResult.meta
          ? chainErr.xrplResult.meta.TransactionResult
          : null;

        if (resultCode === 'tecNO_ENTRY') {
          const alreadyWithOwner = await xrplClient.ownsNFT(stake.owner_wallet, nftTokenId);
          if (alreadyWithOwner) {
            await supabase
              .from('stakes')
              .update({ status: 'unstaked', unstaked_at: new Date().toISOString() })
              .eq('nft_token_id', nftTokenId)
              .eq('status', 'staked');

            return res.status(409).json({
              error: 'This ripplet was already unstaked in an earlier attempt — your records have been corrected. Refresh to see it back in your wallet.',
              alreadyUnstaked: true,
            });
          }
        }
        throw chainErr;
      }
    }

    const acceptRequest = await xumm.createAcceptOfferRequest(offerIndex, stake.owner_wallet);
    res.json(acceptRequest);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create unstake request.', detail: err.message });
  }
});

// Unstake step 2: frontend polls this after the user accepts the offer.
// Before closing the stake out, pay out any accrued-but-unclaimed $RPLTS —
// unstaking should never cause someone to lose rewards they'd already earned.
router.post('/unstake/confirm', async (req, res) => {
  const { uuid, nftTokenId } = req.body;

  try {
    const result = await xumm.getPayloadResult(uuid);
    if (!result.signed) {
      return res.status(202).json({ status: 'pending' });
    }

    const { data: stake, error: fetchErr } = await supabase
      .from('stakes')
      .select('*')
      .eq('nft_token_id', nftTokenId)
      .eq('status', 'staked')
      .maybeSingle();
    if (fetchErr) throw fetchErr;

    let finalPayout = 0;
    if (stake) {
      const accrued = accruedSince(stake.last_claim_at);
      if (accrued > 0) {
        const { data: reserve } = await supabase.from('reserve').select('*').eq('id', 1).single();
        const remaining = reserve.total_reserve - reserve.distributed;
        const payout = Math.min(accrued, Math.max(0, remaining));

        if (payout > 0) {
          const txResult = await xrplClient.sendRPLTS(stake.owner_wallet, payout);
          finalPayout = payout;

          await supabase.from('claims').insert({
            stake_id: stake.id,
            owner_wallet: stake.owner_wallet,
            amount: payout,
            tx_hash: txResult.result.hash,
          });
          await supabase
            .from('reserve')
            .update({ distributed: round2(reserve.distributed + payout) })
            .eq('id', 1);
        }
      }
    }

    const { error } = await supabase
      .from('stakes')
      .update({
        status: 'unstaked',
        unstaked_at: new Date().toISOString(),
        total_claimed: stake ? round2((stake.total_claimed || 0) + finalPayout) : undefined,
      })
      .eq('nft_token_id', nftTokenId)
      .eq('status', 'staked');
    if (error) throw error;

    res.json({ status: 'unstaked', finalPayout });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to confirm unstake.' });
  }
});

module.exports = router;