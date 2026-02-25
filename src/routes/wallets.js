const express = require('express');
const { getNormalTxs, getTokenTxs } = require('../etherscan');
const { runDemoScreening } = require('../demoScreening');
const router = express.Router();
const db = require('../db');

const DEMO_MODE = process.env.DEMO_MODE === '1';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

function uniqCount(arr) {
  return new Set(arr).size;
}

/**
 * Build a deduplicated array of counterparty addresses from combined tx lists.
 * Excludes `addr` itself and non-address strings.
 */
function extractCounterparties(addr, txs, tokentxs) {
  const seen = new Set();
  for (const tx of [...(txs || []), ...(tokentxs || [])]) {
    const from = (tx.from || '').toLowerCase();
    const to   = (tx.to   || '').toLowerCase();
    const cp   = (from === addr) ? to : from;
    if (cp && cp !== addr && /^0x[0-9a-f]{40}$/.test(cp)) {
      seen.add(cp);
    }
  }
  return [...seen];
}

function isRateLimit(err) {
  const m = (err.message || '').toLowerCase();
  return m.includes('rate limit') || m.includes('max rate') || m.includes('notok');
}

// ── Screening constants (overridable via env) ──────────────────────────────────
const HOP1_MAX                = parseInt(process.env.HOP1_MAX                || '10',  10);
const HOP2_MAX_PER_HOP1       = parseInt(process.env.HOP2_MAX_PER_HOP1       || '5',   10);
const MAX_TX_SCAN_PER_ADDRESS = parseInt(process.env.MAX_TX_SCAN_PER_ADDRESS || '200', 10);
const MAX_ETHERSCAN_CALLS     = parseInt(process.env.MAX_ETHERSCAN_CALLS     || '20',  10);
const ETHERSCAN_SLEEP_MS      = parseInt(process.env.ETHERSCAN_SLEEP_MS      || '250', 10);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Main screening function ───────────────────────────────────────────────────

async function runScreening(chain, address, client) {
  if (DEMO_MODE) return runDemoScreening(chain, address, client);

  const addr      = address.toLowerCase();
  const limits    = { hop1_max: HOP1_MAX, hop2_max_per_hop1: HOP2_MAX_PER_HOP1, max_tx_scan_per_address: MAX_TX_SCAN_PER_ADDRESS };
  let callsUsed   = 0;

  // ── 1) Direct blacklist match ─────────────────────────────────────────────
  const { rows: blRows } = await client.query(
    `SELECT id, address, category, note
     FROM blacklist_wallets WHERE chain = $1 AND address = $2 LIMIT 1`,
    [chain, addr]
  );
  if (blRows.length > 0) {
    return {
      status: 'blacklisted', reason: 'Address is in internal blacklist',
      direct_match: true, one_hop_match: false,
      matched_blacklist_address: addr, raw_tx_count: 0,
      details: { hop1_checked: 0, hop2_checked: 0, paths: [], limits, blacklist: blRows[0] },
    };
  }

  // ── 2) Non-ethereum: skip tx analysis ────────────────────────────────────
  if (chain !== 'ethereum') {
    return {
      status: 'clean', reason: 'Heuristic screening not supported for this chain',
      direct_match: false, one_hop_match: false,
      matched_blacklist_address: null, raw_tx_count: 0,
      details: { hop1_checked: 0, hop2_checked: 0, paths: [], limits },
    };
  }

  // ── 3) Fetch root wallet txs ─────────────────────────────────────────────
  let txs, tokentxs;
  if (callsUsed + 2 > MAX_ETHERSCAN_CALLS) {
    return {
      status: 'inconclusive', reason: 'Etherscan call budget exceeded before root fetch',
      direct_match: false, one_hop_match: false,
      matched_blacklist_address: null, raw_tx_count: 0,
      details: { hop1_checked: 0, hop2_checked: 0, paths: [], limits, rate_limited: true, where: 'budget' },
    };
  }
  try {
    [txs, tokentxs] = await Promise.all([
      getNormalTxs(addr, MAX_TX_SCAN_PER_ADDRESS),
      getTokenTxs(addr, MAX_TX_SCAN_PER_ADDRESS),
    ]);
    callsUsed += 2;
    if (ETHERSCAN_SLEEP_MS > 0) await sleep(ETHERSCAN_SLEEP_MS);
  } catch (e) {
    if (isRateLimit(e)) {
      return {
        status: 'inconclusive', reason: 'Etherscan rate limit during screening',
        direct_match: false, one_hop_match: false,
        matched_blacklist_address: null, raw_tx_count: 0,
        details: { hop1_checked: 0, hop2_checked: 0, paths: [], limits, rate_limited: true, where: 'root' },
      };
    }
    throw e;
  }

  // ── 4) Heuristics ─────────────────────────────────────────────────────────
  const outgoing = txs.filter(t => (t.from || '').toLowerCase() === addr);
  const incoming = txs.filter(t => (t.to   || '').toLowerCase() === addr);
  const normalCps = extractCounterparties(addr, txs, []);
  const flags = [];
  if (outgoing.length >= 10) {
    const times = outgoing.map(t => Number(t.timeStamp)).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    for (let i = 0; i + 9 < times.length; i++) {
      if (times[i + 9] - times[i] <= 30 * 60) { flags.push('Outgoing burst: >=10 tx within 30 minutes'); break; }
    }
  }
  if (normalCps.length >= 25) flags.push(`Many counterparties: ${normalCps.length}`);

  const txBase = {
    txs_count: txs.length, token_txs_count: tokentxs.length,
    outgoing_count: outgoing.length, incoming_count: incoming.length, flags,
  };

  // ── 5) Hop-1 counterparties + one-hop blacklist check ────────────────────
  const hop1 = extractCounterparties(addr, txs, tokentxs).slice(0, HOP1_MAX);
  let hop1Matches = [];
  if (hop1.length > 0) {
    const { rows } = await client.query(
      `SELECT address, category, note FROM blacklist_wallets
       WHERE chain = $1 AND address = ANY($2::text[])`,
      [chain, hop1]
    );
    hop1Matches = rows;
  }
  if (hop1Matches.length > 0) {
    return {
      status: 'flagged', reason: '1-hop link to internal blacklist',
      direct_match: false, one_hop_match: true,
      matched_blacklist_address: hop1Matches[0].address, raw_tx_count: txs.length,
      details: {
        ...txBase, hop1_checked: hop1.length, hop2_checked: 0, limits,
        paths: hop1Matches.map(m => ({ from: addr, via: m.address, hit: m.address, hop: 1, category: m.category, note: m.note })),
      },
    };
  }

  // ── 6) Two-hop ────────────────────────────────────────────────────────────
  let hop2Checked = 0;
  for (const h1addr of hop1) {
    if (callsUsed + 2 > MAX_ETHERSCAN_CALLS) {
      return {
        status: 'inconclusive', reason: 'Etherscan call budget exceeded during 2-hop scan',
        direct_match: false, one_hop_match: false,
        matched_blacklist_address: null, raw_tx_count: txs.length,
        details: { ...txBase, hop1_checked: hop1.length, hop2_checked: hop2Checked, limits, rate_limited: true, where: 'budget', paths: [] },
      };
    }
    let h1txs, h1tokentxs;
    try {
      [h1txs, h1tokentxs] = await Promise.all([
        getNormalTxs(h1addr, MAX_TX_SCAN_PER_ADDRESS),
        getTokenTxs(h1addr, MAX_TX_SCAN_PER_ADDRESS),
      ]);
      callsUsed += 2;
      if (ETHERSCAN_SLEEP_MS > 0) await sleep(ETHERSCAN_SLEEP_MS);
    } catch (e) {
      if (isRateLimit(e)) {
        return {
          status: 'inconclusive', reason: 'Etherscan rate limit during screening',
          direct_match: false, one_hop_match: false,
          matched_blacklist_address: null, raw_tx_count: txs.length,
          details: { ...txBase, hop1_checked: hop1.length, hop2_checked: hop2Checked, limits, rate_limited: true, where: 'hop1', paths: [] },
        };
      }
      continue; // non-rate-limit error: skip this hop1
    }

    const hop2 = extractCounterparties(h1addr, h1txs, h1tokentxs).slice(0, HOP2_MAX_PER_HOP1);
    hop2Checked += hop2.length;

    if (hop2.length > 0) {
      const { rows: hop2Matches } = await client.query(
        `SELECT address, category, note FROM blacklist_wallets
         WHERE chain = $1 AND address = ANY($2::text[])`,
        [chain, hop2]
      );
      if (hop2Matches.length > 0) {
        return {
          status: 'flagged', reason: '2-hop link to internal blacklist',
          direct_match: false, one_hop_match: false,
          matched_blacklist_address: hop2Matches[0].address, raw_tx_count: txs.length,
          details: {
            ...txBase, hop1_checked: hop1.length, hop2_checked: hop2Checked, limits,
            paths: hop2Matches.map(m => ({ from: addr, via: h1addr, hit: m.address, hop: 2, category: m.category, note: m.note })),
          },
        };
      }
    }
  }

  // ── 7) Clean / heuristics-only ────────────────────────────────────────────
  const status = flags.length > 0 ? 'flagged' : 'clean';
  const reason = flags.length > 0 ? 'Heuristics triggered' : 'No issues detected';
  return {
    status, reason,
    direct_match: false, one_hop_match: false,
    matched_blacklist_address: null, raw_tx_count: txs.length,
    details: { ...txBase, hop1_checked: hop1.length, hop2_checked: hop2Checked, limits, paths: [] },
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /wallets — create wallet and screen it
router.post('/', async (req, res) => {
  const address = (req.body.address || '').trim().toLowerCase();
  const chain   = (req.body.chain   || 'ethereum').trim().toLowerCase() || 'ethereum';

  if (!isValidAddress(address)) {
    const { rows: wallets } = await db.query(
      `SELECT id, address, chain, status, last_checked_at
       FROM wallets
       ORDER BY created_at DESC`
    );
    return res.render('dashboard', {
      title:       'Dashboard',
      wallets,
      error:       'Invalid address: must start with 0x and be exactly 42 characters.',
      formAddress: address,
      formChain:   chain,
    });
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO wallets (address, chain) VALUES ($1, $2) RETURNING id`,
      [address, chain]
    );
    const walletId = rows[0].id;

    let screening;
    try {
      screening = await runScreening(chain, address, client);
    } catch (screenErr) {
      console.error('[runScreening] unexpected error:', screenErr.message);
      screening = {
        status: 'error', reason: `Screening error: ${screenErr.message}`,
        direct_match: false, one_hop_match: false,
        matched_blacklist_address: null, raw_tx_count: 0,
        details: { hop1_checked: 0, hop2_checked: 0, paths: [], limits: { hop1_max: HOP1_MAX, hop2_max_per_hop1: HOP2_MAX_PER_HOP1, max_tx_scan_per_address: MAX_TX_SCAN_PER_ADDRESS }, rate_limited: false, where: null },
      };
    }

    await client.query(
      `UPDATE wallets SET status = $1, last_checked_at = now() WHERE id = $2`,
      [screening.status, walletId]
    );

    await client.query(
      `INSERT INTO screening_logs
         (wallet_id, direct_match, one_hop_match, matched_blacklist_address,
          raw_tx_count, status, reason, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        walletId,
        screening.direct_match,
        screening.one_hop_match,
        screening.matched_blacklist_address,
        screening.raw_tx_count,
        screening.status,
        screening.reason,
        JSON.stringify(screening.details),
      ]
    );

    await client.query('COMMIT');
    res.redirect(`/wallets/${walletId}`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});

    console.error('[POST /wallets] DB error:', err.message);
    db.debugLog('POST /wallets', err);

    // 23505 = unique_violation: wallet already exists → re-screen and redirect.
    if (err.code === '23505') {
      const existing = await db
        .query(`SELECT id FROM wallets WHERE address = $1 AND chain = $2`, [address, chain])
        .catch(() => ({ rows: [] }));
      if (existing.rows.length > 0) {
        const existingId = existing.rows[0].id;
        const rescreenClient = await db.connect();
        try {
          await rescreenClient.query('BEGIN');
          const screening = await runScreening(chain, address, rescreenClient);
          await rescreenClient.query(
            `UPDATE wallets SET status = $1, last_checked_at = now() WHERE id = $2`,
            [screening.status, existingId]
          );
          await rescreenClient.query(
            `INSERT INTO screening_logs
               (wallet_id, direct_match, one_hop_match, matched_blacklist_address,
                raw_tx_count, status, reason, details)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              existingId,
              screening.direct_match,
              screening.one_hop_match,
              screening.matched_blacklist_address,
              screening.raw_tx_count,
              screening.status,
              screening.reason,
              JSON.stringify(screening.details),
            ]
          );
          await rescreenClient.query('COMMIT');
        } catch (rescreenErr) {
          await rescreenClient.query('ROLLBACK').catch(() => {});
          console.error('[POST /wallets] re-screen error:', rescreenErr.message);
          db.debugLog('POST /wallets re-screen', rescreenErr);
        } finally {
          rescreenClient.release();
        }
        return res.redirect(`/wallets/${existingId}`);
      }
    }

    const { rows: wallets } = await db
      .query(`SELECT id, address, chain, status, last_checked_at FROM wallets ORDER BY created_at DESC`)
      .catch(() => ({ rows: [] }));

    const isDev = process.env.NODE_ENV !== 'production';
    const diagnostic = isDev
      ? (err.constraint ? ` [DB constraint: ${err.constraint}]` : ` [${err.code}: ${err.message}]`)
      : '';

    res.render('dashboard', {
      title:  'Dashboard',
      wallets,
      error:  `Failed to add wallet. It may already exist.${diagnostic}`,
    });
  } finally {
    client.release();
  }
});

// GET /wallets/:id — wallet detail + last screening log
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, address, chain, status, last_checked_at, created_at
       FROM wallets WHERE id = $1`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).render('wallet', {
        title:    'Not Found',
        wallet:   null,
        log:      null,
        error:    'Wallet not found.',
        demoMode: DEMO_MODE,
      });
    }

    const wallet = rows[0];

    const { rows: logs } = await db.query(
      `SELECT * FROM screening_logs
       WHERE wallet_id = $1
       ORDER BY checked_at DESC
       LIMIT 1`,
      [wallet.id]
    );

    res.render('wallet', {
      title:    `Wallet ${wallet.address.slice(0, 10)}…`,
      wallet,
      log:      logs[0] || null,
      error:    null,
      demoMode: DEMO_MODE,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('wallet', {
      title:    'Error',
      wallet:   null,
      log:      null,
      error:    'Database error.',
      demoMode: DEMO_MODE,
    });
  }
});

module.exports = router;
