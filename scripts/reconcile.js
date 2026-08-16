// Reconciliation check: compares what Supabase thinks is staked against
// what the project wallet actually holds on-chain, and flags any mismatch.
//
// Run this any time you want a sanity check — especially after testing lots
// of stake/unstake cycles, or on a schedule once this is live. It never
// writes anything; it only reports.
//
// Usage:
//   node scripts/reconcile.js

require('dotenv').config();
const supabase = require('../lib/supabase');
const xrplClient = require('../lib/xrplClient');

const PROJECT_WALLET_ADDRESS = process.env.PROJECT_WALLET_ADDRESS;

async function main() {
  console.log('Reconciling Supabase stakes against on-chain reality...\n');

  // What the DB thinks is currently staked.
  const { data: dbStaked, error } = await supabase
    .from('stakes')
    .select('nft_token_id, owner_wallet, staked_at')
    .eq('status', 'staked');
  if (error) throw error;

  const dbStakedIds = new Set(dbStaked.map((s) => s.nft_token_id));

  // What the project wallet actually holds on-chain right now.
  const client = await xrplClient.getClient();
  const resp = await client.request({
    command: 'account_nfts',
    account: PROJECT_WALLET_ADDRESS,
  });
  const onChainIds = new Set((resp.result.account_nfts || []).map((n) => n.NFTokenID));

  // Case 1: DB says staked, but the project wallet doesn't actually hold it.
  // Usually means it was already returned to the owner but the DB never
  // got updated (e.g. a crash between the on-chain accept and /confirm).
  const dbSaysStakedButMissingOnChain = [...dbStakedIds].filter((id) => !onChainIds.has(id));

  // Case 2: the project wallet holds an NFT the DB has no active stake row
  // for. Usually means a stake's on-chain accept succeeded but the DB
  // insert/upsert failed right after.
  const onChainButNotInDb = [...onChainIds].filter((id) => !dbStakedIds.has(id));

  if (dbSaysStakedButMissingOnChain.length === 0 && onChainButNotInDb.length === 0) {
    console.log('✅ Everything matches — no drift between Supabase and the chain.');
    return;
  }

  if (dbSaysStakedButMissingOnChain.length > 0) {
    console.log(`⚠️  ${dbSaysStakedButMissingOnChain.length} NFT(s) marked "staked" in Supabase but NOT held by the project wallet:`);
    for (const id of dbSaysStakedButMissingOnChain) {
      const row = dbStaked.find((s) => s.nft_token_id === id);
      console.log(`   - ${id}  (owner: ${row.owner_wallet}, staked_at: ${row.staked_at})`);
    }
    console.log('   → Likely already back with the owner. Run the app\'s unstake flow for');
    console.log('     one of these (it will self-heal the row), or update it manually in Supabase.\n');
  }

  if (onChainButNotInDb.length > 0) {
    console.log(`⚠️  ${onChainButNotInDb.length} NFT(s) held by the project wallet but NOT marked "staked" in Supabase:`);
    for (const id of onChainButNotInDb) {
      console.log(`   - ${id}`);
    }
    console.log('   → Likely an accept succeeded on-chain but the DB write failed right after.');
    console.log('     You\'ll need to manually insert a stakes row for these (owner_wallet unknown');
    console.log('     from this script alone — check the transaction history for that NFT to find it),');
    console.log('     or return it to the owner manually via a one-off unstake script.\n');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Reconciliation failed:', err);
    process.exit(1);
  });