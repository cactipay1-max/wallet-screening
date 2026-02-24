-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Wallets under screening
CREATE TABLE wallets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  address         text        NOT NULL,
  chain           text        NOT NULL DEFAULT 'ethereum',
  status          text        NOT NULL DEFAULT 'clean'
                              CHECK (status IN ('clean', 'flagged', 'blacklisted', 'error')),
  last_checked_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Known bad addresses
CREATE TABLE blacklist_wallets (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  address     text        NOT NULL,
  chain       text        NOT NULL DEFAULT 'ethereum',
  category    text        NOT NULL DEFAULT 'internal',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Audit log per screening run
CREATE TABLE screening_logs (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id                uuid        NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  direct_match             bool        NOT NULL DEFAULT false,
  one_hop_match            bool        NOT NULL DEFAULT false,
  matched_blacklist_address text,
  raw_tx_count             int         NOT NULL DEFAULT 0,
  checked_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_wallets_address          ON wallets (address);
CREATE INDEX idx_blacklist_wallets_address ON blacklist_wallets (address);
