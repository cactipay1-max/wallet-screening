const express = require('express');
const router = express.Router();
const db = require('../db');

router.get('/', async (req, res) => {
  try {
    const { rows: wallets } = await db.query(
      `SELECT id, address, chain, status, last_checked_at
       FROM wallets
       ORDER BY created_at DESC`
    );
    res.render('dashboard', { title: 'Dashboard', wallets, error: null });
  } catch (err) {
    console.error(err);
    res.render('dashboard', { title: 'Dashboard', wallets: [], error: 'Database error loading wallets.' });
  }
});

module.exports = router;
