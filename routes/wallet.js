const express = require('express');
const router = express.Router();
const xrplClient = require('../lib/xrplClient');
const supabase = require('../lib/supabase');
const { accruedSince } = require('../lib/rewards');

const RIPPLETS_NFT_ISSUER = process.env.RIPPLETS_NFT_ISSUER || null;

// Pure read + auto-register — no signature needed. Checking a wallet here
// is what starts the earning clock: we look up what Ripplets it actually
// holds on-chain, and for anything not already tracked, we register it
// (held_since = now). If something WAS tracked under a different owner
// (meaning it changed hands since the last periodic snapshot), we reconcile
// it on the spot too — so checking a wallet also self-heals stale records.
router.get('/wallet/:address/ripplets', async (req, res) => {
  const { address } = req.params;

  if (!RIPPLETS_NFT_ISSUER) {
    return res.json({ nfts: [], note: 'Ripplets not launched yet — RIPPLETS_NFT_ISSUER not set.' });
  }

  try {
    const client = await xrplClient.getClient();
    const resp = await client.request({ command: 'account_nfts', account: address });
    const owned = (resp.result.account_nfts || []).filter((n) => n.Issuer === RIPPLETS_NFT_ISSUER);

    const results = [];
    for (const n of owned) {
      const { data: existing } = await supabase
        .from('nft_holdings')
        .select('*')
        .eq('nft_token_id', n.NFTokenID)
        .maybeSingle();

      if (!existing) {
        // Newly seen — register it, earning starts now.
        const now = new Date().toISOString();
        await supabase.from('nft_holdings').insert({
          nft_token_id: n.NFTokenID,
          owner_wallet: address,
          held_since: now,
          last_claim_at: now,
          last_checked_at: now,
        });
        results.push({ nftTokenId: n.NFTokenID, heldSince: now, accrued: 0, newlyRegistered: true });
      } else if (existing.owner_wallet !== address) {
        // Our record is stale (ownership changed since the last snapshot) —
        // reconcile now instead of waiting for the next scheduled check.
        const now = new Date().toISOString();
        await supabase.from('ownership_changes').insert({
          nft_token_id: n.NFTokenID,
          old_owner: existing.owner_wallet,
          new_owner: address,
          accrued_at_change: accruedSince(existing.last_claim_at),
        });
        await supabase
          .from('nft_holdings')
          .update({ owner_wallet: address, held_since: now, last_claim_at: now, last_checked_at: now })
          .eq('nft_token_id', n.NFTokenID);
        results.push({ nftTokenId: n.NFTokenID, heldSince: now, accrued: 0, reconciled: true });
      } else {
        results.push({
          nftTokenId: n.NFTokenID,
          heldSince: existing.held_since,
          accrued: accruedSince(existing.last_claim_at),
        });
      }
    }

    res.json({ nfts: results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load wallet NFTs.' });
  }
});

// Fetches an NFT's real name/image from its on-chain metadata URI.
router.get('/nft/:nftTokenId/metadata', async (req, res) => {
  const { nftTokenId } = req.params;
  const { owner } = req.query;

  try {
    const meta = await xrplClient.getNFTMetadata(nftTokenId, [owner]);
    if (!meta) return res.status(404).json({ error: 'Could not resolve metadata for this NFT.' });
    res.json(meta);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load NFT metadata.' });
  }
});

// Simple image proxy — fetches the real image server-side (where the
// browser's cross-origin restrictions don't apply) and re-serves it from
// our own domain. Only allows known-safe IPFS gateway hosts, so this can't
// be abused as an open proxy for arbitrary URLs.
const ALLOWED_IMAGE_HOSTS = ['ipfs.io', 'gateway.pinata.cloud', 'nftstorage.link', 'dweb.link'];

router.get('/image-proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url parameter.');

  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    return res.status(400).send('Invalid url.');
  }
  if (!ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) {
    return res.status(403).send('Host not allowed.');
  }

  try {
    const upstream = await fetch(parsed.toString());
    if (!upstream.ok) return res.status(upstream.status).send('Upstream fetch failed.');

    const contentType = upstream.headers.get('content-type') || 'image/png';
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400'); // images don't change, cache a day
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to proxy image.');
  }
});

module.exports = router;
