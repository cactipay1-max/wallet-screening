// src/db.js
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn('[db] WARNING: DATABASE_URL is not set — queries will fail');
}

const isRailwayProxy = (connectionString || '').includes('proxy.rlwy.net');

const pool = new Pool({
  connectionString,
  ssl: isRailwayProxy ? { rejectUnauthorized: false } : undefined,
});

// Without this handler, idle SSL errors in Node v24 crash the process.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

pool.healthCheck = async function () {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
};

// Log DB errors with extra context when DEBUG_SQL=true.
// Safe to call in every catch block — no-ops in production unless the flag is set.
pool.debugLog = function (context, err) {
  if (process.env.DEBUG_SQL === 'true') {
    console.error(`[DB DEBUG][${context}]`, {
      message: err.message,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
      where: err.where,
      hint: err.hint,
    });
  }
};

module.exports = pool;
