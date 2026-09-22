-- Run this once against your PostgreSQL database, e.g.:
--   psql -U postgres -d file_upload_db -f db/schema.sql

CREATE TABLE IF NOT EXISTS files (
    id              UUID PRIMARY KEY,
    original_name   TEXT NOT NULL,
    stored_name     TEXT NOT NULL,
    mime_type       TEXT,
    extension       TEXT,
    size_bytes      BIGINT NOT NULL DEFAULT 0,
    uploaded_bytes  BIGINT NOT NULL DEFAULT 0,
    status          VARCHAR(20) NOT NULL DEFAULT 'uploading', -- uploading | completed | failed
    storage_path    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_files_updated_at ON files;
CREATE TRIGGER trg_files_updated_at
BEFORE UPDATE ON files
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
