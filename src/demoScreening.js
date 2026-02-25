// src/demoScreening.js — deterministic screening using demo/graph.json
// Only called when DEMO_MODE=1. Never hits Etherscan.

const fs   = require('fs');
const path = require('path');

let _adj = null;
function loadGraph() {
  if (_adj) return _adj;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../demo/graph.json'), 'utf8'));
  _adj = new Map();
  for (const [a, b] of raw.edges) {
    const al = a.toLowerCase(), bl = b.toLowerCase();
    if (!_adj.has(al)) _adj.set(al, new Set());
    if (!_adj.has(bl)) _adj.set(bl, new Set());
    _adj.get(al).add(bl);
    _adj.get(bl).add(al);
  }
  return _adj;
}

async function runDemoScreening(chain, address, client) {
  const addr  = address.toLowerCase();
  const graph = loadGraph();
  const limits = { demo: true };

  // 1) Direct blacklist match
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

  // 2) Hop-1 neighbours
  const hop1 = graph.has(addr) ? [...graph.get(addr)] : [];

  if (hop1.length > 0) {
    const { rows: hop1Matches } = await client.query(
      `SELECT address, category, note FROM blacklist_wallets
       WHERE chain = $1 AND address = ANY($2::text[])`,
      [chain, hop1]
    );
    if (hop1Matches.length > 0) {
      return {
        status: 'flagged', reason: '1-hop link to internal blacklist',
        direct_match: false, one_hop_match: true,
        matched_blacklist_address: hop1Matches[0].address, raw_tx_count: 0,
        details: {
          hop1_checked: hop1.length, hop2_checked: 0, limits,
          paths: hop1Matches.map(m => ({
            from: addr, via: m.address, hit: m.address,
            hop: 1, category: m.category, note: m.note,
          })),
        },
      };
    }
  }

  // 3) Hop-2
  let hop2Checked = 0;
  for (const h1addr of hop1) {
    const hop2 = graph.has(h1addr)
      ? [...graph.get(h1addr)].filter(n => n !== addr)
      : [];
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
          matched_blacklist_address: hop2Matches[0].address, raw_tx_count: 0,
          details: {
            hop1_checked: hop1.length, hop2_checked: hop2Checked, limits,
            paths: hop2Matches.map(m => ({
              from: addr, via: h1addr, hit: m.address,
              hop: 2, category: m.category, note: m.note,
            })),
          },
        };
      }
    }
  }

  return {
    status: 'clean', reason: 'No blacklist linkage found',
    direct_match: false, one_hop_match: false,
    matched_blacklist_address: null, raw_tx_count: 0,
    details: { hop1_checked: hop1.length, hop2_checked: hop2Checked, paths: [], limits },
  };
}

module.exports = { runDemoScreening };
