-- Run this once against your PostgreSQL database, e.g.:
--   psql -U postgres -d chunked_upload_db -f db/schema.sql

CREATE TABLE IF NOT EXISTS uploads (
    id                  UUID PRIMARY KEY,
    file_name           TEXT NOT NULL,
    mime_type           TEXT,
    extension           TEXT,
    total_size          BIGINT NOT NULL,
    chunk_size          BIGINT NOT NULL,
    total_chunks        INTEGER NOT NULL,
    checksum            TEXT,                 -- optional client-provided sha256 of the whole file
    status              VARCHAR(20) NOT NULL DEFAULT 'initiated', -- initiated | uploading | completed | aborted | failed
    final_storage_path  TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);
CREATE INDEX IF NOT EXISTS idx_uploads_created_at ON uploads(created_at);

-- One row per chunk actually received. The UNIQUE constraint on
-- (upload_id, chunk_index) is what makes duplicate-chunk handling and
-- concurrent chunk uploads safe: a resend of the same chunk index is an
-- UPSERT (ON CONFLICT ... DO UPDATE), never a duplicate row, and Postgres
-- serializes concurrent writers on that same row via normal row locking.
CREATE TABLE IF NOT EXISTS upload_chunks (
    id              BIGSERIAL PRIMARY KEY,
    upload_id       UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
    chunk_index     INTEGER NOT NULL,
    size_bytes      BIGINT NOT NULL,
    checksum        TEXT,                     -- optional client-provided sha256 of this chunk
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (upload_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_upload_chunks_upload_id ON upload_chunks(upload_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_uploads_updated_at ON uploads;
CREATE TRIGGER trg_uploads_updated_at
BEFORE UPDATE ON uploads
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
