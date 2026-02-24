require('dotenv').config();

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const db = require('./db');

const app = express();

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
