const express = require('express');
const { getNormalTxs, getTokenTxs } = require('../etherscan');
const router = express.Router();
const db = require('../db');

function isValidAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

function uniqCount(arr) {
  return new Set(arr).size;
}

async function runScreening(chain, address, client) {
  const addr = address.toLowerCase();

  // 1) direct match: blacklist
  const bl = await client.query(
    `select id, address, category, note
     from blacklist_wallets
     where chain = $1 and address = $2
     limit 1`,
    [chain, addr]
  );

  if (bl.rows.length > 0) {
    return {
      status: 'blacklisted',
      reason: 'Address is in internal blacklist',
      direct_match: true,
      one_hop_match: false,
      matched_blacklist_address: addr,
      raw_tx_count: 0,
      details: {
        blacklist: bl.rows[0],
        txs_fetched: { normal: 0, token: 0 },
        counterparties_total: 0,
        counterparties_sample: [],
        one_hop_matches: [],
      },
    };
  }

  // 2) Etherscan txs — only supported for ethereum
  if (chain !== 'ethereum') {
    return {
      status: 'clean',
      reason: 'Heuristic screening not supported for this chain',
      direct_match: false,
      one_hop_match: false,
      matched_blacklist_address: null,
      raw_tx_count: 0,
      details: {
        flags: [],
        txs_fetched: { normal: 0, token: 0 },
        counterparties_total: 0,
        counterparties_sample: [],
        one_hop_matches: [],
      },
    };
  }

  const limit = Number(process.env.SCREEN_TX_LIMIT || 100);
  const [txs, tokentxs] = await Promise.all([
    getNormalTxs(addr, limit),
    getTokenTxs(addr, limit),
  ]);

  // 3) Extract counterparties from normal txs (used for heuristics)
  const outgoing = txs.filter((t) => (t.from || '').toLowerCase() === addr);
  const incoming = txs.filter((t) => (t.to || '').toLowerCase() === addr);

  const normalCounterparties = txs
    .map((t) => {
      const from = (t.from || '').toLowerCase();
      const to = (t.to || '').toLowerCase();
      return from === addr ? to : from;
    })
    .filter((a) => a && a !== addr);

  const uniqCounterparties = uniqCount(normalCounterparties);

  // 4) One-hop: merge counterparties from both normal and token txs, then query blacklist
  const tokenCounterparties = tokentxs
    .map((t) => {
      const from = (t.from || '').toLowerCase();
      const to = (t.to || '').toLowerCase();
      return from === addr ? to : from;
    })
    .filter((a) => a && a !== addr);

  const allCounterparties = [...new Set([...normalCounterparties, ...tokenCounterparties])];

  let oneHopMatches = [];
  if (allCounterparties.length > 0) {
    const { rows: blMatches } = await client.query(
      `SELECT address, category, note
       FROM blacklist_wallets
       WHERE chain = $1 AND address = ANY($2::text[])`,
      [chain, allCounterparties]
    );
    oneHopMatches = blMatches;
  }

  // 5) Heuristic flags
  let burst = false;
  if (outgoing.length >= 10) {
    const times = outgoing
      .map((t) => Number(t.timeStamp))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    for (let i = 0; i + 9 < times.length; i++) {
      if (times[i + 9] - times[i] <= 30 * 60) {
        burst = true;
        break;
      }
    }
  }

  const flags = [];
  if (burst) flags.push('Outgoing burst: >=10 tx within 30 minutes');
  if (uniqCounterparties >= 25) flags.push(`Many counterparties: ${uniqCounterparties}`);

  // 6) Determine final status + reason
  let status, reason;
  const reasonParts = [];
  if (oneHopMatches.length > 0) reasonParts.push('One-hop match with internal blacklist');
  if (flags.length) reasonParts.push('Heuristics triggered');

  if (reasonParts.length > 0) {
    status = 'flagged';
    reason = reasonParts.join('; ');
  } else {
    status = 'clean';
    reason = 'No issues detected';
  }

  return {
    status,
    reason,
    direct_match: false,
    one_hop_match: oneHopMatches.length > 0,
    matched_blacklist_address: oneHopMatches.length > 0 ? oneHopMatches[0].address : null,
    raw_tx_count: txs.length,
    details: {
      txs_count: txs.length,
      token_txs_count: tokentxs.length,
      outgoing_count: outgoing.length,
      incoming_count: incoming.length,
      uniq_counterparties: uniqCounterparties,
      counterparties_total: allCounterparties.length,
      counterparties_sample: allCounterparties.slice(0, 30),
      one_hop_matches: oneHopMatches,
      txs_fetched: { normal: txs.length, token: tokentxs.length },
      flags,
    },
  };
}

// POST /wallets — create wallet and screen it
router.post('/', async (req, res) => {
  const address = (req.body.address || '').trim().toLowerCase();
  const chain = (req.body.chain || 'ethereum').trim().toLowerCase() || 'ethereum';

  if (!isValidAddress(address)) {
    const { rows: wallets } = await db.query(
      `SELECT id, address, chain, status, last_checked_at
       FROM wallets
       ORDER BY created_at DESC`
    );

    return res.render('dashboard', {
      title: 'Dashboard',
      wallets,
      error: 'Invalid address: must start with 0x and be exactly 42 characters.',
      formAddress: address,
      formChain: chain,
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

    const screening = await runScreening(chain, address, client);

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

    // Always log at warn level; DEBUG_SQL adds full diagnostic.
    console.error('[POST /wallets] DB error:', err.message);
    db.debugLog('POST /wallets', err);

    // 23505 = unique_violation on wallets(address, chain): wallet already exists.
    // Re-run screening on the existing record and redirect to it.
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

    // In development expose the DB diagnostic so bugs are obvious.
    const isDev = process.env.NODE_ENV !== 'production';
    const diagnostic = isDev
      ? (err.constraint ? ` [DB constraint: ${err.constraint}]` : ` [${err.code}: ${err.message}]`)
      : '';

    res.render('dashboard', {
      title: 'Dashboard',
      wallets,
      error: `Failed to add wallet. It may already exist.${diagnostic}`,
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
        title: 'Not Found',
        wallet: null,
        log: null,
        error: 'Wallet not found.',
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
      title: `Wallet ${wallet.address.slice(0, 10)}…`,
      wallet,
      log: logs[0] || null,
      error: null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).render('wallet', {
      title: 'Error',
      wallet: null,
      log: null,
      error: 'Database error.',
    });
  }
});

module.exports = router;