-- Run this once against your PostgreSQL database, e.g.:
--   psql -U postgres -d csv_import_db -f db/schema.sql

CREATE TABLE IF NOT EXISTS imports (
    id                  UUID PRIMARY KEY,
    original_filename   TEXT NOT NULL,
    stored_path         TEXT NOT NULL,
    size_bytes          BIGINT NOT NULL,
    mime_type           TEXT,
    status              VARCHAR(20) NOT NULL DEFAULT 'UPLOADED', -- UPLOADED | PROCESSING | COMPLETED | FAILED
    total_rows          INTEGER,
    processed_rows      INTEGER NOT NULL DEFAULT 0,
    valid_rows          INTEGER NOT NULL DEFAULT 0,
    invalid_rows        INTEGER NOT NULL DEFAULT 0,
    duplicate_rows      INTEGER NOT NULL DEFAULT 0,
    error_file_path     TEXT,
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at          TIMESTAMPTZ,
    completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_imports_status ON imports(status);

-- The actual data rows successfully imported. `phone` is UNIQUE across the
-- WHOLE table (not just within one import) - we're treating "duplicate
-- phone number" as a system-wide business rule (a phone number identifies
-- one contact, regardless of which file it came from). This is also what
-- makes re-running/retrying a failed import job safe: re-processing rows
-- that were already inserted on a prior attempt just makes them show up
-- as "duplicate" the second time, never duplicated in the table.
--
-- If your actual requirement is "unique only within a single file", drop
-- the UNIQUE constraint here and instead dedupe purely in application code
-- in services/csvProcessor.js (see the comments there for exactly where).
CREATE TABLE IF NOT EXISTS contacts (
    id          BIGSERIAL PRIMARY KEY,
    import_id   UUID REFERENCES imports(id) ON DELETE SET NULL,
    row_number  INTEGER,
    name        TEXT,
    email       TEXT,
    phone       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT contacts_phone_unique UNIQUE (phone)
);

CREATE INDEX IF NOT EXISTS idx_contacts_import_id ON contacts(import_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_imports_updated_at ON imports;
CREATE TRIGGER trg_imports_updated_at
BEFORE UPDATE ON imports
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
