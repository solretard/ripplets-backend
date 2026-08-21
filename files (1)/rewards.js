// Reward math — kept in one place so the API and the snapshot job can't
// drift out of sync on the rate.

const DAILY_RATE = 10;          // $RPLTS per held ripplet per day
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MIN = 60 * 1000;

// TESTING ONLY: set REWARD_TEST_MODE=true in .env to accrue per-minute
// instead of per-day, so you can watch rewards build up in real time while
// debugging instead of waiting hours/days. Turn this OFF before launch —
// leaving it on would let real users farm rewards absurdly fast.
const TEST_MODE = process.env.REWARD_TEST_MODE === 'true';
const TEST_RATE_PER_MIN = parseFloat(process.env.REWARD_TEST_RATE_PER_MIN || '0.1');

/**
 * How much $RPLTS has accrued since the last claim (or since first held,
 * if never claimed), as of right now.
 */
function accruedSince(lastClaimAt) {
  const elapsedMs = Date.now() - new Date(lastClaimAt).getTime();
  if (TEST_MODE) {
    const minutes = Math.max(0, elapsedMs / MS_PER_MIN);
    return round2(minutes * TEST_RATE_PER_MIN);
  }
  const days = Math.max(0, elapsedMs / MS_PER_DAY);
  return round2(days * DAILY_RATE);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { DAILY_RATE, accruedSince, round2 };
