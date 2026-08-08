#!/usr/bin/env node
/**
 * apply-migration.mjs — run a SQL migration file against the Supabase Postgres.
 *
 * Usage:
 *   SUPABASE_DB_PASSWORD=… node scripts/apply-migration.mjs path/to/migration.sql
 *
 * Requires SUPABASE_DB_PASSWORD (your Supabase project's database password).
 * Tries the direct DB host first (IPv6), then the session poolers (IPv4) —
 * whichever connects wins.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const file = process.argv[2];
if (!file) {
  console.error('Usage: SUPABASE_DB_PASSWORD=… node scripts/apply-migration.mjs <file.sql>');
  process.exit(1);
}
const sql = readFileSync(file, 'utf8');

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const ref = new URL(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
const password = process.env.SUPABASE_DB_PASSWORD;
if (!password) {
  console.error('SUPABASE_DB_PASSWORD not set (find it in your Supabase project settings)');
  process.exit(1);
}

const candidates = [
  { host: `db.${ref}.supabase.co`, port: 5432, user: 'postgres' },
  ...['ap-southeast-2', 'ap-southeast-1', 'us-east-1', 'us-west-1', 'eu-central-1'].map((r) => ({
    host: `aws-0-${r}.pooler.supabase.com`,
    port: 5432,
    user: `postgres.${ref}`,
  })),
];

let client = null;
for (const c of candidates) {
  const attempt = new pg.Client({
    host: c.host,
    port: c.port,
    user: c.user,
    password,
    database: 'postgres',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 8000,
  });
  try {
    await attempt.connect();
    client = attempt;
    console.log(`Connected via ${c.host}`);
    break;
  } catch (e) {
    console.log(`  ${c.host}: ${e.code || e.message}`);
  }
}
if (!client) {
  console.error('Could not connect to the database on any host.');
  process.exit(1);
}

try {
  await client.query('begin');
  await client.query(sql);
  await client.query('commit');
  console.log(`Applied ${file}`);
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.error(`Migration failed (rolled back): ${e.message}`);
  process.exit(1);
} finally {
  await client.end();
}
