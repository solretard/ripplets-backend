const xrpl = require('xrpl');

const NETWORK = process.env.XRPL_NETWORK || 'wss://xrplcluster.com'; // mainnet
const HOT_WALLET_MNEMONIC = process.env.PROJECT_WALLET_MNEMONIC;
const HOT_WALLET_SEED = process.env.PROJECT_WALLET_SEED; // fallback if you use classic seed instead
const RPLTS_ISSUER = process.env.RPLTS_ISSUER_ADDRESS; // same wallet as PROJECT_WALLET_ADDRESS in the merged setup
const RPLTS_CURRENCY_CODE = process.env.RPLTS_CURRENCY_CODE || 'RPLTS'; // 3-char or 40-char hex

if (!HOT_WALLET_MNEMONIC && !HOT_WALLET_SEED) {
  throw new Error('Set PROJECT_WALLET_MNEMONIC (12/24-word phrase) or PROJECT_WALLET_SEED in your environment.');
}
if (!RPLTS_ISSUER) {
  throw new Error('Set RPLTS_ISSUER_ADDRESS — the wallet address that issues $RPLTS.');
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
 * Looks up an NFT's CURRENT owner directly from the ledger — the source of
 * truth the cycle job and on-the-spot reconciliation both rely on.
 * Requires a Clio-enabled node (xrplcluster.com is).
 */
async function getCurrentOwner(nftTokenId) {
  const client = await getClient();
  const resp = await client.request({ command: 'nft_info', nft_id: nftTokenId });
  return resp.result.owner || null;
}

/**
 * Sends $RPLTS from the issuer/project wallet to a destination. The
 * destination here should ALWAYS come from our own verified nft_holdings
 * record (the on-chain-confirmed current owner) — never from unauthenticated
 * user input — which is what makes this safe to call without requiring the
 * recipient to sign anything.
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

  const txResult = result.result.meta && result.result.meta.TransactionResult;
  if (txResult !== 'tesSUCCESS') {
    const err = new Error(`$RPLTS payment failed on-chain: ${txResult || 'unknown result'}`);
    err.xrplResult = result.result;
    throw err;
  }

  return result;
}

/**
 * Converts an ipfs:// URI to a fetchable https gateway URL.
 */
function resolveIpfs(uri) {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.replace('ipfs://', '')}`;
  }
  return uri;
}

/**
 * Finds an NFT's real name/image from its on-chain metadata URI, checking
 * whichever candidate wallet(s) currently hold it.
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
        return { name: meta.name || null, image: resolveIpfs(meta.image) || null };
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

/**
 * Checks whether a wallet has a trustline for $RPLTS. Read-only — used to
 * show a friendly warning ("set this up yourself in Xaman first") rather
 * than our app ever prompting a signature for it.
 */
async function hasTrustline(walletAddress) {
  const client = await getClient();
  const resp = await client.request({
    command: 'account_lines',
    account: walletAddress,
    peer: RPLTS_ISSUER,
  });
  return (resp.result.lines || []).some((line) => line.currency === RPLTS_CURRENCY_CODE);
}

module.exports = {
  getClient,
  getHotWallet,
  getCurrentOwner,
  sendRPLTS,
  getNFTMetadata,
  hasTrustline,
  RPLTS_ISSUER,
  RPLTS_CURRENCY_CODE,
};
