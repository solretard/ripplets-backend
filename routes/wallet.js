const express = require('express');
const router = express.Router();
const xrplClient = require('../lib/xrplClient');
const supabase = require('../lib/supabase');

const PROJECT_WALLET_ADDRESS = process.env.PROJECT_WALLET_ADDRESS;

// Optional: once Ripplets is minted, set RIPPLETS_NFT_ISSUER in .env to filter
// this down to only Ripplets NFTs. Until then, shows everything in the wallet
// so you can test staking with any NFT you already own (e.g. a Trenchers piece).
const RIPPLETS_NFT_ISSUER = process.env.RIPPLETS_NFT_ISSUER || null;

router.get('/wallet/:address/nfts', async (req, res) => {
  const { address } = req.params;

  // Refuse to return anything until the real Ripplets issuer is configured —
  // showing someone's whole wallet (unrelated NFTs from other projects) is
  // not something this endpoint should ever do, even by accident.
  if (!RIPPLETS_NFT_ISSUER) {
    return res.json({ nfts: [], filtered: true, note: 'RIPPLETS_NFT_ISSUER not set yet — collection not launched.' });
  }

  try {
    const client = await xrplClient.getClient();
    const resp = await client.request({
      command: 'account_nfts',
      account: address,
    });

    let nfts = resp.result.account_nfts || [];

    if (RIPPLETS_NFT_ISSUER) {
      nfts = nfts.filter((n) => n.Issuer === RIPPLETS_NFT_ISSUER);
    }

    // Exclude anything already staked (shouldn't normally show up anyway,
    // since staked NFTs live in the project wallet, not here — but belt and
    // braces in case of a sync delay).
    const { data: activeStakes } = await supabase
      .from('stakes')
      .select('nft_token_id')
      .eq('status', 'staked');
    const stakedIds = new Set((activeStakes || []).map((s) => s.nft_token_id));

    const available = nfts
      .filter((n) => !stakedIds.has(n.NFTokenID))
      .map((n) => ({
        nftTokenId: n.NFTokenID,
        issuer: n.Issuer,
        taxon: n.NFTokenTaxon,
      }));

    res.json({ nfts: available, filtered: Boolean(RIPPLETS_NFT_ISSUER) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load wallet NFTs.' });
  }
});

// Fetches an NFT's real name/image from its on-chain metadata URI.
// Pass ?owner=<address> if you know which wallet currently holds it
// (e.g. the connected user's wallet for unstaked NFTs) — the project
// wallet is always checked too, since staked NFTs live there.
router.get('/nft/:nftTokenId/metadata', async (req, res) => {
  const { nftTokenId } = req.params;
  const { owner } = req.query;

  try {
    const meta = await xrplClient.getNFTMetadata(nftTokenId, [owner, PROJECT_WALLET_ADDRESS]);
    if (!meta) return res.status(404).json({ error: 'Could not resolve metadata for this NFT.' });
    res.json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load NFT metadata.' });
  }
});

module.exports = router;
