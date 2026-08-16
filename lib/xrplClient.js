const xrpl = require('xrpl');

const NETWORK = process.env.XRPL_NETWORK || 'wss://xrplcluster.com'; // mainnet
const HOT_WALLET_MNEMONIC = process.env.PROJECT_WALLET_MNEMONIC;
const HOT_WALLET_SEED = process.env.PROJECT_WALLET_SEED; // fallback if you use classic seed instead
const RPLTS_ISSUER = process.env.RPLTS_ISSUER_ADDRESS; // same wallet as PROJECT_WALLET_ADDRESS in the merged setup
const RPLTS_CURRENCY_CODE = process.env.RPLTS_CURRENCY_CODE || 'RPLTS'; // 3-char or 40-char hex

if (!HOT_WALLET_MNEMONIC && !HOT_WALLET_SEED) {
  throw new Error('Set PROJECT_WALLET_MNEMONIC (24-word phrase) or PROJECT_WALLET_SEED in your environment.');
}
if (!RPLTS_ISSUER) {
  throw new Error('Set RPLTS_ISSUER_ADDRESS — the wallet address that issued the $RPLTS token.');
}

let clientPromise = null;

async function getClient() {
  if (!clientPromise) {
    const client = new xrpl.Client(NETWORK);
    clientPromise = client.connect().then(() => client);
  }
  return clientPromise;
}

function getHotWallet() {
  if (HOT_WALLET_MNEMONIC) {
    return xrpl.Wallet.fromMnemonic(HOT_WALLET_MNEMONIC);
  }
  return xrpl.Wallet.fromSeed(HOT_WALLET_SEED);
}

/**
 * Project wallet accepts an incoming NFTokenOffer (the user's stake offer),
 * taking custody of the NFT into the project/escrow wallet.
 */
async function acceptNFTOffer(offerIndex) {
  const client = await getClient();
  const wallet = getHotWallet();

  const tx = {
    TransactionType: 'NFTokenAcceptOffer',
    Account: wallet.address,
    NFTokenSellOffer: offerIndex,
  };

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  return result;
}

/**
 * Project wallet creates a zero-cost sell offer back to the original owner
 * so they can accept it in Xaman and get their NFT back (unstake step 1).
 */
async function createReturnOffer(nftTokenId, ownerAddress) {
  const client = await getClient();
  const wallet = getHotWallet();

  const tx = {
    TransactionType: 'NFTokenCreateOffer',
    Account: wallet.address,
    NFTokenID: nftTokenId,
    Amount: '0',
    Destination: ownerAddress,
    Flags: 1, // tfSellNFToken
  };

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);

  // Don't trust this succeeded just because submitAndWait resolved —
  // check the actual on-chain result first. A `tec`-class result (e.g.
  // the project wallet not actually holding this NFT) still gets included
  // in a ledger and resolves here, but creates no NFTokenOffer.
  const txResult = result.result.meta && result.result.meta.TransactionResult;
  if (txResult !== 'tesSUCCESS') {
    const err = new Error(
      `NFTokenCreateOffer (return offer) failed on-chain: ${txResult || 'unknown result'}`
    );
    err.xrplResult = result.result;
    throw err;
  }

  // Pull the offer index out of the tx metadata so the frontend can hand it
  // to the owner's Xaman NFTokenAcceptOffer request.
  const meta = result.result.meta;
  const created = meta.AffectedNodes.find(
    (n) => n.CreatedNode && n.CreatedNode.LedgerEntryType === 'NFTokenOffer'
  );
  if (!created) {
    throw new Error(
      'NFTokenCreateOffer succeeded on-chain but no NFTokenOffer node was found in the transaction metadata — unexpected response shape.'
    );
  }
  const offerIndex = created.CreatedNode.LedgerIndex;

  return { result, offerIndex };
}

/**
 * Send $RPLTS (issued currency) from the issuer/hot wallet to a claimant.
 * Requires the claimant to already have a trustline set for $RPLTS —
 * check this client-side and prompt a TrustSet via Xaman first if missing.
 */
async function sendRPLTS(destinationAddress, amount) {
  const client = await getClient();
  const wallet = getHotWallet();

  const tx = {
    TransactionType: 'Payment',
    Account: wallet.address,
    Destination: destinationAddress,
    Amount: {
      currency: RPLTS_CURRENCY_CODE,
      issuer: RPLTS_ISSUER,
      value: String(amount),
    },
  };

  const prepared = await client.autofill(tx);
  const signed = wallet.sign(prepared);
  const result = await client.submitAndWait(signed.tx_blob);
  return result;
}

/**
 * Confirms a wallet actually holds the NFT it claims to be staking, and
 * that it isn't already staked. Call before creating a stake record.
 */
async function ownsNFT(walletAddress, nftTokenId) {
  const client = await getClient();
  const resp = await client.request({
    command: 'account_nfts',
    account: walletAddress,
  });
  return resp.result.account_nfts.some((n) => n.NFTokenID === nftTokenId);
}

/**
 * Converts an ipfs:// URI to a fetchable https gateway URL. Leaves
 * https:// URIs alone.
 */
function resolveIpfs(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.replace('ipfs://', '')}`;
  }
  return uri;
}

/**
 * Finds an NFT's metadata (name + image) by checking its URI field.
 * Since staked NFTs live in the project wallet and unstaked ones live in
 * the owner's wallet, we check whichever candidate wallets are given.
 */
async function getNFTMetadata(nftTokenId, ownerHints = []) {
  const client = await getClient();
  const candidates = [...new Set(ownerHints.filter(Boolean))];

  for (const owner of candidates) {
    try {
      const resp = await client.request({ command: 'account_nfts', account: owner });
      const match = (resp.result.account_nfts || []).find((n) => n.NFTokenID === nftTokenId);
      if (match && match.URI) {
        const uriString = Buffer.from(match.URI, 'hex').toString('utf8');
        const metadataUrl = resolveIpfs(uriString);
        const metaResp = await fetch(metadataUrl);
        if (!metaResp.ok) continue;
        const meta = await metaResp.json();
        return {
          name: meta.name || null,
          image: resolveIpfs(meta.image) || null,
        };
      }
    } catch (e) {
      continue; // try next candidate
    }
  }
  return null;
}

/**
 * Checks whether a wallet already has a trustline set for $RPLTS —
 * required before that wallet can receive any claim payout.
 */
async function hasTrustline(walletAddress) {
  const client = await getClient();
  const resp = await client.request({
    command: 'account_lines',
    account: walletAddress,
    peer: RPLTS_ISSUER,
  });
  return (resp.result.lines || []).some(
    (line) => line.currency === RPLTS_CURRENCY_CODE
  );
}

module.exports = { getClient, getHotWallet, acceptNFTOffer, createReturnOffer, sendRPLTS, ownsNFT, getNFTMetadata, hasTrustline, RPLTS_ISSUER, RPLTS_CURRENCY_CODE };