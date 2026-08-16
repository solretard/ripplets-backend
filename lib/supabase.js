const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.');
}

// Service key, not anon key — this server is the only thing writing stakes,
// so it needs to bypass row-level security. Never ship the service key to
// the frontend.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

module.exports = supabase;

