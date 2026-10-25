-- Tracking table for the migration runner (the runner also creates it if missing,
-- so this file just records the bootstrap as version 000_bootstrap).
CREATE SCHEMA IF NOT EXISTS qlens;
CREATE TABLE IF NOT EXISTS qlens.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
