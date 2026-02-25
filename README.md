# Wallet Screening — Internal MVP

Internal tool for screening Ethereum wallet addresses against an internal blacklist.
Supports direct match, one-hop counterparty match, and multi-hop BFS (Stage 3).

## Prerequisites

- Node.js 18+
- PostgreSQL 14+

## Setup

### 1. Configure environment

**PowerShell:**
```powershell
Copy-Item .env.example .env
```

**Bash / Git Bash:**
```bash
cp .env.example .env
```

Edit `.env` and set your database connection string:

```
DATABASE_URL=postgres://user:password@localhost:5432/wallet_screening
PORT=3000
ETHERSCAN_API_KEY=your_key_here
ETHERSCAN_BASE_URL=https://api.etherscan.io/v2/api

# Screening tuning
SCREEN_TX_LIMIT=100          # txs fetched per address per Etherscan call
MAX_HOPS=2                   # multi-hop BFS depth (2 or 3)

# Multi-hop safety limits (prevent rate-limit explosion)
MAX_VISITED_ADDRESSES=200
MAX_COUNTERPARTIES_PER_ADDRESS=80
MAX_ETHERSCAN_CALLS=20
TIMEOUT_MS=15000

# Optional
DEBUG_SQL=false
```

### 2. Create database and run schema

**PowerShell:**
```powershell
createdb wallet_screening
psql $env:DATABASE_URL -f sql/schema.sql
```

**Bash:**
```bash
createdb wallet_screening
psql $DATABASE_URL -f sql/schema.sql
```

Or with explicit credentials:

```powershell
psql -U postgres -d wallet_screening -f sql/schema.sql
```

> **Note:** Auto-migrations run at startup (idempotent). You only need to apply the base schema once.

### 3. Install dependencies

```
npm install
```

### 4. Run

Development (auto-restart on change):

```
npm run dev
```

Production:

```
npm start
```

Open http://localhost:3000

### 5. Stop the server

**PowerShell** (no `pkill`):
```powershell
# In the terminal running the server: Ctrl+C
# Or force-kill all node processes:
Stop-Process -Name node -Force
```

**Bash:**
```bash
# Ctrl+C in the terminal running the server
```

## Routes

| Method | Path                   | Description                          |
|--------|------------------------|--------------------------------------|
| GET    | /                      | Dashboard — wallet list + add form   |
| POST   | /wallets               | Submit address for screening         |
| GET    | /wallets/:id           | Wallet detail + last screening log   |
| GET    | /blacklist             | Blacklist list + add form            |
| POST   | /blacklist             | Add address to blacklist             |
| POST   | /blacklist/:id/delete  | Remove blacklist entry               |
| GET    | /health                | Health check (JSON)                  |

## DB Schema

- **wallets** — screened addresses with status (`clean`, `flagged`, `blacklisted`, `error`)
- **blacklist_wallets** — known bad addresses with category and optional note
- **screening_logs** — one row per screening run; includes direct_match, one_hop_match, details (JSONB)

## Screening logic (Stage 3)

1. **Direct match** — wallet address in `blacklist_wallets` → `blacklisted`
2. **One-hop match** — any direct counterparty (normal + token txs) in `blacklist_wallets` → `flagged`
3. **Multi-hop match** — BFS across counterparty graph up to `MAX_HOPS` (default 2) deep; first blacklisted address found → `flagged` with full path shown in UI
4. **Heuristics** — outgoing burst (≥10 tx in 30 min) or many counterparties (≥25) → `flagged`
5. **Clean** — none of the above

Priority: direct > one-hop > multi-hop > heuristics.
Re-submitting an existing wallet re-runs screening and updates its status.

### Multi-hop safety limits

| Env var | Default | Effect |
|---------|---------|--------|
| `MAX_HOPS` | 2 | BFS depth limit (set 3 for 3-hop) |
| `MAX_VISITED_ADDRESSES` | 200 | Stop BFS after visiting this many addresses |
| `MAX_COUNTERPARTIES_PER_ADDRESS` | 80 | Truncate counterparty list per hop address |
| `MAX_ETHERSCAN_CALLS` | 20 | Max Etherscan calls during BFS |
| `TIMEOUT_MS` | 15000 | Max milliseconds for BFS per screening |

If limits stop the search before a match, `details.multi_hop.partial=true` and `stop_reason` is recorded in the screening log. App never crashes on limit hits.

## Debug mode

Set `DEBUG_SQL=true` in `.env` to log full DB error details (code, constraint, hint) to the console without crashing the server.

## Manual test checklist

```
Stage 2
1. Screen a clean wallet → CLEAN, One-Hop: No, Multi-Hop: No
2. Add a direct counterparty to blacklist, re-screen → FLAGGED, One-Hop: Yes
3. Screen same wallet twice → second screen succeeds, status updated
4. GET /health → {"ok":true,"db":true}
5. Submit invalid address → clear error message on dashboard

Stage 3 — multi-hop
A. Screen a wallet with no txs → CLEAN, Multi-Hop: No, partial=false
B. Identify a hop-2 address (counterparty of a counterparty); add it to blacklist;
   re-screen → FLAGGED, Multi-Hop: Yes (depth 2), path shown in UI
C. Set MAX_ETHERSCAN_CALLS=1 and screen a busy wallet →
   Multi-Hop: No, partial=true, stop_reason=etherscan_call_limit shown in UI

PowerShell — set env vars for one run without editing .env:
  $env:MAX_HOPS=3; $env:MAX_ETHERSCAN_CALLS=1; npm run dev
```
