# Wallet Screening — Internal MVP

Internal tool for screening Ethereum wallet addresses against a blacklist.
Supports direct match and one-hop counterparty match.

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

# Optional
SCREEN_TX_LIMIT=100
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

## Screening logic (Stage 2)

1. **Direct match** — wallet address found in `blacklist_wallets` → status `blacklisted`
2. **One-hop match** — any counterparty of the wallet's txs (normal + token) found in `blacklist_wallets` → status `flagged`; matched addresses shown in detail page
3. **Heuristics** — outgoing burst (>=10 tx in 30 min) or many counterparties (>=25) → status `flagged`
4. **Clean** — none of the above

Re-submitting an existing wallet re-runs screening and updates its status.

## Debug mode

Set `DEBUG_SQL=true` in `.env` to log full DB error details (code, constraint, hint) to the console without crashing the server.

## Manual test checklist

```
1. Screen a clean wallet → CLEAN, One-Hop: No
2. Add a counterparty address to blacklist, re-screen the wallet that interacted with it → FLAGGED, One-Hop: Yes, matched address listed
3. Screen same wallet twice → second screen succeeds (no duplicate error), status updated
4. GET /health → {"ok":true,"db":true}
5. Submit invalid address → clear error message on dashboard
```
