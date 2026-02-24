# Wallet Screening — Internal MVP

Internal tool for screening Ethereum wallet addresses against a blacklist.
Stage 1: skeleton with placeholder screening (always returns `clean`).

## Prerequisites

- Node.js 18+
- PostgreSQL 14+

## Setup

### 1. Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set your database connection string:

```
DATABASE_URL=postgres://user:password@localhost:5432/wallet_screening
PORT=3000
```

### 2. Create database and run schema

```bash
# Create the database (if it doesn't exist)
createdb wallet_screening

# Apply schema
psql $DATABASE_URL -f sql/schema.sql
```

Or using psql directly:

```bash
psql -U postgres -d wallet_screening -f sql/schema.sql
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run

Development (auto-restart on change):

```bash
npm run dev
```

Production:

```bash
npm start
```

Open http://localhost:3000

## Routes

| Method | Path          | Description                          |
|--------|---------------|--------------------------------------|
| GET    | /             | Dashboard — wallet list + add form   |
| POST   | /wallets      | Submit address for screening         |
| GET    | /wallets/:id  | Wallet detail + last screening log   |
| GET    | /blacklist    | Blacklist list + add form            |
| POST   | /blacklist    | Add address to blacklist             |

## DB Schema

- **wallets** — screened addresses with status (`clean`, `flagged`, `blacklisted`, `error`)
- **blacklist_wallets** — known bad addresses with category and optional note
- **screening_logs** — one row per screening run (direct match, one-hop match, tx count)

## Stage 2 (planned)

- Replace placeholder `runScreening()` in `src/routes/wallets.js` with real Etherscan API logic:
  - Fetch transactions for the address
  - Check direct match against `blacklist_wallets`
  - Check one-hop: counterparties of each tx against `blacklist_wallets`
  - Set status to `flagged` or `blacklisted` accordingly
