const { XummSdk } = require('xumm-sdk');

if (!process.env.XUMM_API_KEY || !process.env.XUMM_API_SECRET) {
  throw new Error('Set XUMM_API_KEY and XUMM_API_SECRET in your environment.');
}

const xumm = new XummSdk(process.env.XUMM_API_KEY, process.env.XUMM_API_SECRET);

/**
 * Sign-in request — just to identify the connecting wallet address.
 */
async function createSignInRequest() {
  const payload = await xumm.payload.create({
    txjson: { TransactionType: 'SignIn' },
  });
  return { uuid: payload.uuid, qr: payload.refs.qr_png, deeplink: payload.next.always };
}

/**
 * Stake step: user creates a zero-cost NFT sell offer with Destination
 * set to the project wallet. Project wallet then accepts it (see
 * xrplClient.acceptNFTOffer) to take custody.
 */
async function createStakeOfferRequest(nftTokenId, ownerAddress, projectWalletAddress) {
  const payload = await xumm.payload.create({
    txjson: {
      TransactionType: 'NFTokenCreateOffer',
      Account: ownerAddress,
      NFTokenID: nftTokenId,
      Amount: '0',
      Destination: projectWalletAddress,
      Flags: 1, // tfSellNFToken
    },
  });
  return { uuid: payload.uuid, qr: payload.refs.qr_png, deeplink: payload.next.always };
}

/**
 * Unstake step 2: user accepts the return offer the project wallet already
 * created (see xrplClient.createReturnOffer).
 */
async function createAcceptOfferRequest(offerIndex, ownerAddress) {
  const payload = await xumm.payload.create({
    txjson: {
      TransactionType: 'NFTokenAcceptOffer',
      Account: ownerAddress,
      NFTokenSellOffer: offerIndex,
    },
  });
  return { uuid: payload.uuid, qr: payload.refs.qr_png, deeplink: payload.next.always };
}

/**
 * $RPLTS trustline — user needs this once before they can ever receive
 * the token. Prompt this the first time claim() fails due to no trustline.
 */
async function createTrustlineRequest(ownerAddress, issuerAddress, currencyCode) {
  const payload = await xumm.payload.create({
    txjson: {
      TransactionType: 'TrustSet',
      Account: ownerAddress,
      LimitAmount: {
        currency: currencyCode,
        issuer: issuerAddress,
        value: '1000000000', // generous ceiling, not a balance
      },
    },
  });
  return { uuid: payload.uuid, qr: payload.refs.qr_png, deeplink: payload.next.always };
}

/**
 * Poll (or webhook-receive) a payload's resolution.
 */
async function getPayloadResult(uuid) {
  const payload = await xumm.payload.get(uuid);
  return {
    signed: payload.meta.signed,
    resolved: payload.meta.resolved,
    account: payload.response.account,
    txid: payload.response.txid,
  };
}

module.exports = {
  createSignInRequest,
  createStakeOfferRequest,
  createAcceptOfferRequest,
  createTrustlineRequest,
  getPayloadResult,
};

