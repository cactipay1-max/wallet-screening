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

module.exports = pool;
