require('dotenv').config();

const basicAuth = require('express-basic-auth');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const db = require('./db');

const app = express();

const BASIC_AUTH_ENABLED = process.env.BASIC_AUTH_ENABLED === '1';

if (BASIC_AUTH_ENABLED) {
  const user = process.env.BASIC_AUTH_USER || 'admin';
  const pass = process.env.BASIC_AUTH_PASS || '';

  if (!pass) {
    console.warn('[auth] BASIC_AUTH_PASS is empty — refusing to start');
    process.exit(1);
  }

  app.use(
    basicAuth({
      users: { [user]: pass },
      challenge: true,
      realm: 'Wallet Screening',
    })
  );
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '../views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// Body parsing
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Health check — quick way to verify DB connectivity without touching the UI.
app.get('/health', async (req, res) => {
  try {
    await db.healthCheck();
    res.json({ ok: true, db: true });
  } catch (err) {
    console.error('[health]', err.message);
    res.status(503).json({ ok: false, db: false, message: err.message });
  }
});

// Routes
app.use('/', require('./routes/dashboard'));
app.use('/wallets', require('./routes/wallets'));
app.use('/blacklist', require('./routes/blacklist'));

// Admin seed — only active when DEMO_MODE=1
if (process.env.DEMO_MODE === '1') {
  const DEMO_BLACKLIST = [
    '0xd05c5e04fb0f098e49e46b1d2629d20ace0dd012',
    '0x94932baf91959b75818a9a1acc0e2d9ec34858a8',
    '0xa6082264a789a52af17084ff9797d952240891f4',
    '0xdd3d72c53ff982ff59853da71158bf1538b3ceee',
    '0x6eab2d891d1eb89b06aa75d6a2a4420a6668259f',
    '0xd14adf022e913a7a329741f994f37162a965fb00',
    '0xedf1ab977f28b40d3b071de561d2e8376febde9d',
  ];
  app.post('/admin/seed-demo', async (req, res) => {
    const token = req.headers['x-admin-token'];
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    try {
      for (const address of DEMO_BLACKLIST) {
        await db.query(
          `INSERT INTO blacklist_wallets (address, chain, category, note)
           SELECT $1, 'ethereum', 'SANCTIONS', 'demo-seed'
           WHERE NOT EXISTS (
             SELECT 1 FROM blacklist_wallets WHERE address = $1 AND chain = 'ethereum'
           )`,
          [address]
        );
      }
      res.json({ ok: true, seeded: DEMO_BLACKLIST });
    } catch (err) {
      console.error('[seed-demo]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}

// 404
app.use((req, res) => {
  res.status(404).send('Not found');
});

// Error handler (catches synchronous throws from route handlers)
app.use((err, req, res, next) => {
  console.error('[error handler]', err);
  res.status(500).send('Internal server error: ' + err.message);
});

const PORT = process.env.PORT || 3000;

// Run idempotent migrations before accepting traffic.
// Keeps schema in sync without requiring a manual psql step.
async function runMigrations() {
  const client = await db.connect();
  try {
    // migrate_001: status/reason/details on screening_logs
    await client.query(`
      ALTER TABLE screening_logs
        ADD COLUMN IF NOT EXISTS status  TEXT,
        ADD COLUMN IF NOT EXISTS reason  TEXT,
        ADD COLUMN IF NOT EXISTS details JSONB
    `);
    // migrate_002: deduplicate wallets then add unique constraint.
    // Keep the newest row per (address, chain); cascade deletes orphaned logs.
    await client.query(`
      DELETE FROM wallets
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (PARTITION BY address, chain ORDER BY created_at DESC) AS rn
          FROM wallets
        ) ranked
        WHERE rn > 1
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_address_chain
        ON wallets (address, chain)
    `);
    // migrate_003: expand wallets.status to include 'inconclusive'
    await client.query(`
      ALTER TABLE wallets DROP CONSTRAINT IF EXISTS wallets_status_check
    `);
    await client.query(`
      ALTER TABLE wallets ADD CONSTRAINT wallets_status_check
        CHECK (status IN ('clean','flagged','blacklisted','error','inconclusive'))
    `);
    console.log('[migrations] OK');
  } catch (err) {
    console.error('[migrations] FAILED:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Wallet screening app running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('[startup] Exiting — migration failed:', err.message);
    process.exit(1);
  });
