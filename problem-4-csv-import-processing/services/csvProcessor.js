const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');

const pool = require('../config/db');
const { ERRORS_DIR, BATCH_SIZE } = require('../config/constants');
const { mapRow, validateRow } = require('../utils/validators');
const ErrorCsvWriter = require('../utils/errorCsvWriter');
const { countLines } = require('../utils/lineCounter');

const ERROR_CSV_HEADERS = ['rowNumber', 'name', 'email', 'phone', 'reason'];

async function importStillExists(importId) {
  const { rows } = await pool.query('SELECT 1 FROM imports WHERE id = $1', [importId]);
  return rows.length > 0;
}

async function updateImport(importId, fields) {
  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, value] of Object.entries(fields)) {
    setClauses.push(`${key} = $${i}`);
    values.push(value);
    i += 1;
  }
  values.push(importId);
  await pool.query(`UPDATE imports SET ${setClauses.join(', ')} WHERE id = $${i}`, values);
}

/**
 * Bulk-inserts a batch's field-valid, within-batch-deduped candidate rows.
 * `ON CONFLICT (phone) DO NOTHING RETURNING phone` means:
 *   - a phone that already exists (from an earlier batch of this same
 *     import, or a completely different import) is silently skipped
 *   - whatever phones ARE returned are the ones that actually got inserted
 * The caller diffs `candidates` against the returned set to know which
 * ones were duplicates.
 */
async function insertBatch(importId, candidateRows) {
  if (!candidateRows.length) return new Set();

  const values = [];
  const placeholders = candidateRows.map((row, idx) => {
    const base = idx * 5;
    values.push(importId, row.rowNumber, row.name || null, row.email || null, row.phone);
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });

  const { rows: insertedRows } = await pool.query(
    `INSERT INTO contacts (import_id, row_number, name, email, phone)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (phone) DO NOTHING
     RETURNING phone`,
    values
  );

  return new Set(insertedRows.map((r) => r.phone));
}

/**
 * Validates, dedupes-within-batch, and inserts one batch (~1000 rows).
 * Every row ends up in exactly one bucket: valid (inserted), invalid
 * (failed field validation), or duplicate (field-valid but the phone was
 * already taken - either earlier in this same file, or from a prior import).
 */
async function processBatch(importId, batch, errorWriter, counters) {
  const candidates = [];
  const seenPhonesInBatch = new Set();

  for (const item of batch) {
    const { rowNumber, mapped } = item;
    const fieldErrors = validateRow(mapped);

    if (fieldErrors.length) {
      counters.invalid += 1;
      // eslint-disable-next-line no-await-in-loop
      await errorWriter.writeRow([rowNumber, mapped.name, mapped.email, mapped.phone, fieldErrors.join('; ')]);
      continue;
    }

    if (seenPhonesInBatch.has(mapped.phone)) {
      counters.duplicate += 1;
      // eslint-disable-next-line no-await-in-loop
      await errorWriter.writeRow([
        rowNumber,
        mapped.name,
        mapped.email,
        mapped.phone,
        'Duplicate phone number (repeated within this file)',
      ]);
      continue;
    }

    seenPhonesInBatch.add(mapped.phone);
    candidates.push({ rowNumber, ...mapped });
  }

  let insertedPhones;
  try {
    insertedPhones = await insertBatch(importId, candidates);
  } catch (err) {
    // Defensive fallback: if the bulk insert fails for a reason OTHER than
    // a conflict (e.g. a transient DB error), record the batch as errored
    // rather than silently losing rows.
    for (const c of candidates) {
      counters.invalid += 1;
      // eslint-disable-next-line no-await-in-loop
      await errorWriter.writeRow([c.rowNumber, c.name, c.email, c.phone, `Insert failed: ${err.message}`]);
    }
    return;
  }

  for (const c of candidates) {
    if (insertedPhones.has(c.phone)) {
      counters.valid += 1;
    } else {
      counters.duplicate += 1;
      // eslint-disable-next-line no-await-in-loop
      await errorWriter.writeRow([c.rowNumber, c.name, c.email, c.phone, 'Duplicate phone number (already exists)']);
    }
  }
}

/**
 * Main entry point, called by the BullMQ worker for a given importId.
 * Streams the CSV with csv-parse (constant memory regardless of file
 * size), groups rows into ~BATCH_SIZE-row batches, validates + dedupes +
 * inserts each batch, streams anything invalid/duplicate into an error
 * CSV, and keeps the `imports` row's progress columns updated as it goes
 * so GET /status reflects live progress without waiting for completion.
 */
async function processImport(importId, onProgress) {
  const { rows } = await pool.query('SELECT * FROM imports WHERE id = $1', [importId]);
  if (!rows.length) {
    throw new Error(`Import ${importId} not found (it may have been deleted)`);
  }
  const importRow = rows[0];

  await updateImport(importId, { status: 'PROCESSING', started_at: new Date() });

  const totalLines = await countLines(importRow.stored_path);
  const totalRows = Math.max(0, totalLines - 1); // minus header row
  await updateImport(importId, { total_rows: totalRows });

  const errorFilePath = path.join(ERRORS_DIR, `${importId}-errors.csv`);
  const errorWriter = new ErrorCsvWriter(errorFilePath, ERROR_CSV_HEADERS);

  const counters = { processed: 0, valid: 0, invalid: 0, duplicate: 0 };
  let batch = [];
  let rowNumber = 1; // treat the header as row 1, so first data row is row 2

  const parser = fs
    .createReadStream(importRow.stored_path)
    .pipe(parse({ columns: true, skip_empty_lines: true, trim: true, relax_column_count: true }));

  try {
    // for-await-of on a stream naturally respects backpressure: the
    // underlying read stream won't advance past what we've consumed, so
    // awaiting the batch DB work below pauses CSV reading automatically -
    // no manual .pause()/.resume() bookkeeping needed.
    for await (const rawRow of parser) {
      rowNumber += 1;
      const mapped = mapRow(rawRow);
      batch.push({ rowNumber, mapped });

      if (batch.length >= BATCH_SIZE) {
        // eslint-disable-next-line no-await-in-loop
        await processBatch(importId, batch, errorWriter, counters);
        counters.processed += batch.length;
        batch = [];

        // eslint-disable-next-line no-await-in-loop
        await updateImport(importId, {
          processed_rows: counters.processed,
          valid_rows: counters.valid,
          invalid_rows: counters.invalid,
          duplicate_rows: counters.duplicate,
        });
        if (onProgress) onProgress(counters, totalRows);

        // eslint-disable-next-line no-await-in-loop
        if (!(await importStillExists(importId))) {
          console.log(`Import ${importId} was deleted mid-processing; stopping.`);
          await errorWriter.close();
          return;
        }
      }
    }

    if (batch.length) {
      await processBatch(importId, batch, errorWriter, counters);
      counters.processed += batch.length;
    }

    await errorWriter.close();

    const hasErrors = errorWriter.count > 0;
    await updateImport(importId, {
      status: 'COMPLETED',
      processed_rows: counters.processed,
      valid_rows: counters.valid,
      invalid_rows: counters.invalid,
      duplicate_rows: counters.duplicate,
      error_file_path: hasErrors ? errorFilePath : null,
      completed_at: new Date(),
    });

    if (!hasErrors) {
      fs.unlink(errorFilePath, () => {}); // nothing worth keeping - just the header row
    }
  } catch (err) {
    await errorWriter.close().catch(() => {});
    await updateImport(importId, {
      status: 'FAILED',
      error_message: err.message,
      completed_at: new Date(),
    });
    throw err;
  }
}

module.exports = { processImport };
