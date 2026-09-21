#!/usr/bin/env node
// One-time backfill: pushes all existing SQLite rows into Supabase.
// Safe to re-run — uses upsert (merge-duplicates), so no duplicates are created.
//
// Run from the Railway Express Service console:
//   node scripts/backfill-supabase.js

require('dotenv').config();

const Database = require('better-sqlite3');
const { upsert, configured } = require('../lib/supabase');

const DB_PATH = process.env.DB_PATH || 'miniapp.db';

if (!configured()) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set — aborting');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

async function backfillTable(sqliteTable, supabaseTable, transform) {
  const rows = db.prepare(`SELECT * FROM ${sqliteTable} ORDER BY id ASC`).all();
  if (!rows.length) {
    console.log(`${sqliteTable}: 0 rows — nothing to backfill`);
    return;
  }

  const BATCH = 200;
  let sent = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map(transform);
    await upsert(supabaseTable, batch);
    sent += batch.length;
    process.stdout.write(`\r${sqliteTable}: ${sent}/${rows.length}`);
  }
  console.log(`\r${sqliteTable}: ${sent} rows backfilled ✓`);
}

async function main() {
  console.log(`DB: ${DB_PATH}`);

  await backfillTable('logbook_entries', 'sms_logbook_entries', r => ({
    id: Number(r.id),
    employee_id: r.employee_id,
    employee_name_raw: r.employee_name_raw,
    manager_phone: r.manager_phone,
    company_id: r.company_id,
    body: r.body,
    tags: (() => { try { return JSON.parse(r.tags); } catch { return []; } })(),
    source_message_id: r.source_message_id,
    created_at: r.created_at,
  }));

  await backfillTable('technician_media', 'sms_technician_media', r => ({
    id: Number(r.id),
    technician_id: r.technician_id,
    technician_name: r.technician_name,
    technician_phone: r.technician_phone,
    company_id: r.company_id,
    media_url: r.media_url,
    media_content_type: r.media_content_type,
    caption: r.caption,
    created_at: r.created_at,
  }));

  await backfillTable('message_log', 'sms_message_log', r => ({
    id: Number(r.id),
    manager_phone: r.manager_phone,
    direction: r.direction,
    body: r.body,
    parsed_json: (() => { try { return r.parsed_json ? JSON.parse(r.parsed_json) : null; } catch { return null; } })(),
    step_before: r.step_before,
    step_after: r.step_after,
    created_at: r.created_at,
  }));

  console.log('Backfill complete.');
  db.close();
}

main().catch(err => {
  console.error('Backfill failed:', err.message);
  process.exit(1);
});
