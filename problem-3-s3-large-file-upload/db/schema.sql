-- Run this once against your PostgreSQL database, e.g.:
--   psql -U postgres -d s3_upload_db -f db/schema.sql
--
-- NOTE: unlike Problem 2, there is no "parts" table here. S3 itself keeps
-- track of which parts have been uploaded for an in-progress multipart
-- upload (queried via ListParts), so we don't need to duplicate that state
-- in our own database - we just cache upload-session metadata here.

CREATE TABLE IF NOT EXISTS uploads (
    id              UUID PRIMARY KEY,
    file_name       TEXT NOT NULL,
    mime_type       TEXT,
    total_size      BIGINT NOT NULL,
    part_size       BIGINT NOT NULL,
    total_parts     INTEGER NOT NULL,
    bucket          TEXT NOT NULL,
    object_key      TEXT NOT NULL,
    s3_upload_id    TEXT NOT NULL,          -- S3's own multipart upload id
    status          VARCHAR(20) NOT NULL DEFAULT 'initiated', -- initiated | uploading | completed | aborted | expired
    final_location  TEXT,
    final_etag      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ NOT NULL     -- abandoned-upload expiry (see cleanupExpired.js)
);

CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads(status);
CREATE INDEX IF NOT EXISTS idx_uploads_expires_at ON uploads(expires_at);

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
