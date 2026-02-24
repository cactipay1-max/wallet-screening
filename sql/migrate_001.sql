-- Migration 001: add status/reason/details to screening_logs
-- Safe to run multiple times (IF NOT EXISTS / idempotent column adds).

ALTER TABLE screening_logs
  ADD COLUMN IF NOT EXISTS status  TEXT,
  ADD COLUMN IF NOT EXISTS reason  TEXT,
  ADD COLUMN IF NOT EXISTS details JSONB;

-- raw_tx_count and checked_at already exist in the original schema; listed
-- here for reference only — no-op on an up-to-date DB.
-- ALTER TABLE screening_logs ADD COLUMN IF NOT EXISTS raw_tx_count INT NOT NULL DEFAULT 0;
-- ALTER TABLE screening_logs ADD COLUMN IF NOT EXISTS checked_at   TIMESTAMPTZ NOT NULL DEFAULT now();
