const express = require('express');
const router = express.Router();
const db = require('../db');

function isValidAddress(address) {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

// GET /blacklist
router.get('/', async (req, res) => {
  try {
    const { rows: entries } = await db.query(
      `SELECT id, address, chain, category, note, created_at
       FROM blacklist_wallets
       ORDER BY created_at DESC`
    );
    res.render('blacklist', { title: 'Blacklist', entries, error: null });
  } catch (err) {
    console.error(err);
    res.render('blacklist', { title: 'Blacklist', entries: [], error: 'Database error.' });
  }
});

// POST /blacklist
router.post('/', async (req, res) => {
  const address = (req.body.address || '').trim().toLowerCase();
  const chain = (req.body.chain || 'ethereum').trim().toLowerCase() || 'ethereum';
  const category = (req.body.category || 'internal').trim() || 'internal';
  const note = (req.body.note || '').trim() || null;

  // Always safe to call: swallows DB errors and returns [] so UI never crashes.
  async function getEntries() {
    try {
      const { rows } = await db.query(
        `SELECT id, address, chain, category, note, created_at
         FROM blacklist_wallets ORDER BY created_at DESC`
      );
      return rows;
    } catch (e) {
      console.error('[blacklist getEntries]', e.message);
      return [];
    }
  }

  if (!isValidAddress(address)) {
    return res.render('blacklist', {
      title: 'Blacklist',
      entries: await getEntries(),
      error: 'Invalid address: must start with 0x and be exactly 42 characters.',
    });
  }

  try {
    await db.query(
      `INSERT INTO blacklist_wallets (address, chain, category, note)
       VALUES ($1, $2, $3, $4)`,
      [address, chain, category, note]
    );
    res.redirect('/blacklist');
  } catch (err) {
    console.error('[blacklist POST]', err.message);
    res.render('blacklist', {
      title: 'Blacklist',
      entries: await getEntries(),
      error: 'Failed to add entry. It may already exist.',
    });
  }
});

// POST /blacklist/:id/delete
router.post('/:id/delete', async (req, res) => {
  try {
    await db.query('DELETE FROM blacklist_wallets WHERE id = $1', [req.params.id]);
  } catch (err) {
    console.error('[blacklist DELETE]', err.message);
  }
  res.redirect('/blacklist');
});

module.exports = router;
