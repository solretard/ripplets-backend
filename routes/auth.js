const express = require('express');
const router = express.Router();
const xumm = require('../lib/xumm');
const xrplClient = require('../lib/xrplClient');

// Frontend calls this to kick off "connect wallet" — returns a QR/deeplink
// for the user to scan/tap, and a uuid to poll for the result.
router.post('/signin', async (req, res) => {
  try {
    const request = await xumm.createSignInRequest();
    res.json(request);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create sign-in request.' });
  }
});

// Frontend polls this every couple seconds until `resolved` is true.
router.get('/signin/:uuid', async (req, res) => {
  try {
    const result = await xumm.getPayloadResult(req.params.uuid);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check sign-in status.' });
  }
});

// Generic payload status check — used by the frontend to poll ANY Xaman
// payload (stake offers, unstake accepts, trustlines), not just sign-in.
router.get('/payload/:uuid', async (req, res) => {
  try {
    const result = await xumm.getPayloadResult(req.params.uuid);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check payload status.' });
  }
});

// Check whether a wallet already has a trustline for $RPLTS.
router.get('/trustline/:wallet', async (req, res) => {
  try {
    const exists = await xrplClient.hasTrustline(req.params.wallet);
    res.json({ hasTrustline: exists });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to check trustline.' });
  }
});

// Get a Xaman payload for setting the $RPLTS trustline.
router.post('/trustline/request', async (req, res) => {
  const { wallet } = req.body;
  if (!wallet) return res.status(400).json({ error: 'wallet is required.' });

  try {
    const request = await xumm.createTrustlineRequest(
      wallet,
      xrplClient.RPLTS_ISSUER,
      xrplClient.RPLTS_CURRENCY_CODE
    );
    res.json(request);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create trustline request.' });
  }
});

module.exports = router;
