/**
 * Run this ONCE, right after minting, to register all 100 Ripplets in the
 * hold-to-earn system. After this, the snapshot job takes over automatically.
 *
 * Input: a JSON file mapping each minted NFT to its initial owner —
 * you'll have this from your mint transaction results (each NFTokenMint
 * response includes the new NFTokenID; the owner is whoever you minted to).
 *
 * Expected format (mint-results.json):
 * [
 *   { "nftTokenId": "000817...", "ownerWallet": "rXXXX..." },
 *   { "nftTokenId": "000817...", "ownerWallet": "rYYYY..." },
 *   ...
 * ]
 *
 * Usage: node scripts/seedHoldings.js path/to/mint-results.json
 */

require('dotenv').config();
const fs = require('fs');
const supabase = require('../lib/supabase');

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node scripts/seedHoldings.js path/to/mint-results.json');
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const mints = JSON.parse(raw);

  console.log(`Seeding ${mints.length} NFTs into nft_holdings...\n`);

  let inserted = 0;
  let skipped = 0;

  for (const m of mints) {
    if (!m.nftTokenId || !m.ownerWallet) {
      console.log(`  Skipping invalid entry: ${JSON.stringify(m)}`);
      skipped++;
      continue;
    }

    const { error } = await supabase.from('nft_holdings').upsert({
      nft_token_id: m.nftTokenId,
      owner_wallet: m.ownerWallet,
      held_since: new Date().toISOString(),
      last_claim_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
    }, { onConflict: 'nft_token_id' });

    if (error) {
      console.log(`  Failed on ${m.nftTokenId}: ${error.message}`);
      skipped++;
    } else {
      inserted++;
    }
  }

  console.log(`\nDone. ${inserted} seeded, ${skipped} skipped.`);
  console.log('From here, run scripts/runCycle.js on a schedule to keep ownership current and pay out rewards automatically.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
