/** Disposable local PostgreSQL: conversion idempotency and send-race. Synthetic data only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const binaries = process.env.PG_BIN;
if (!binaries) throw new Error('Set PG_BIN to local PostgreSQL server binaries. This test must not use a live database.');
const env = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', PGCONNECT_TIMEOUT: '5' };
const root = realpathSync(mkdtempSync('/tmp/dh-cornerman-'));
chmodSync(root, 0o700);
const data = join(root, 'cluster');
const socket = join(root, 'socket');
mkdirSync(socket, { mode: 0o700 });
const pgBin = (name, args = []) => execFileSync(join(binaries, name), args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const sqlFile = (name) => readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const FILES = [
  '001_backend_core.sql', '002_crm_core.sql', '003_schema_migrations.sql', '004_agent_keys.sql',
  '005_home_events.sql', '006_money.sql', '007_payment_receipts.sql', '008_agent_approvals.sql',
  '900_cornerman_conversion.sql',
];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function withCluster(run) {
  pgBin('initdb', ['-D', data, '-U', 'conversion_test', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  pgBin('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h '' -k ${socket} -p 55441`, '-w', 'start']);
  try {
    pgBin('createdb', ['-h', socket, '-p', '55441', '-U', 'conversion_test', 'conversion']);
    const admin = new pg.Client({ host: socket, port: 55441, user: 'conversion_test', database: 'conversion' });
    await admin.connect();
    await admin.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema storage; create table storage.buckets(id text primary key, name text, public boolean);
      create table storage.objects(id uuid primary key, bucket_id text);
      create extension if not exists "uuid-ossp";`);
    await admin.query(readFileSync(new URL('./fixtures/frontend-2.5.4.sql', import.meta.url), 'utf8'));
    for (const file of FILES) await admin.query(sqlFile(file));
    await run(admin);
    await admin.end();
  } finally {
    try { pgBin('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); } catch { /* already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
}

function client() {
  return new pg.Client({ host: socket, port: 55441, user: 'conversion_test', database: 'conversion' });
}

async function seed(db) {
  const lead = (await db.query("insert into leads(email, first_name) values('race@example.test','Pat') returning id")).rows[0].id;
  const workflow = (await db.query(
    "insert into workflows(name, status, purpose, steps) values('nurture','active','prospect_nurture','[]') returning id"
  )).rows[0].id;
  const enrollment = (await db.query(
    'insert into workflow_enrollments(workflow_id, lead_id, status, current_step) values($1,$2,$3,0) returning id',
    [workflow, lead, 'active']
  )).rows[0].id;
  return { lead, enrollment };
}

async function convert(db, lead, payload, eventId) {
  return (await db.query(
    'select public.apply_cornerman_conversion_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
    ['cornerman', 'staging', eventId, 1, hash(payload), lead, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']
  )).rows[0].result;
}

test('actual dump-free local PostgreSQL serializes identical conversions and send races', async () => {
  await withCluster(async (admin) => {
    const { lead, enrollment } = await seed(admin);
    const a = client();
    const b = client();
    await a.connect();
    await b.connect();
    try {
      const eventId = '11111111-1111-4111-8111-111111111111';
      const payload = { lead, eventId };
      const [first, second] = await Promise.all([
        convert(a, lead, payload, eventId),
        convert(b, lead, payload, eventId),
      ]);
      const codes = [first.code, second.code].sort();
      assert.deepEqual(codes, ['applied', 'replay']);
      assert.equal((await admin.query('select count(*)::int as n from conversion_receipts')).rows[0].n, 1);
      assert.equal((await admin.query("select count(*)::int as n from lead_activities where activity_type='status_changed'")).rows[0].n, 1);

      const lead2 = (await admin.query("insert into leads(email, first_name) values('second@example.test','Sam') returning id")).rows[0].id;
      const workflow2 = (await admin.query(
        "insert into workflows(name, status, purpose, steps) values('nurture-2','active','prospect_nurture','[]') returning id"
      )).rows[0].id;
      const enrollment2 = (await admin.query(
        'insert into workflow_enrollments(workflow_id, lead_id, status, current_step) values($1,$2,$3,0) returning id',
        [workflow2, lead2, 'active']
      )).rows[0].id;
      const reserved = (await a.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment2])).rows[0].result;
      assert.equal(reserved.ok, true);
      const raced = await convert(b, lead2, { lead2 }, '22222222-2222-4222-8222-222222222222');
      assert.equal(raced.code, 'needs_review');
      const losing = await a.query(
        "update workflow_enrollments set current_step = 1 where id = $1 and status = 'active' returning id",
        [enrollment2]
      );
      assert.equal(losing.rowCount, 0);
      assert.equal((await admin.query('select status, current_step from workflow_enrollments where id=$1', [enrollment2])).rows[0].status, 'exited');

      const lead3 = (await admin.query("insert into leads(email, first_name) values('third@example.test','Lee') returning id")).rows[0].id;
      const workflow3 = (await admin.query(
        "insert into workflows(name, status, purpose, steps) values('nurture-3','active','prospect_nurture','[]') returning id"
      )).rows[0].id;
      const enrollment3 = (await admin.query(
        'insert into workflow_enrollments(workflow_id, lead_id, status, current_step) values($1,$2,$3,0) returning id',
        [workflow3, lead3, 'active']
      )).rows[0].id;
      await convert(a, lead3, { lead3 }, '33333333-3333-4333-8333-333333333333');
      const after = (await b.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment3])).rows[0].result;
      assert.equal(after.ok, false);
      assert.ok(['converted', 'not_active'].includes(after.code));

      const [tickA, tickB] = await Promise.all([
        a.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment]),
        b.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment]),
      ]);
      const reserveCodes = [tickA.rows[0].result.code, tickB.rows[0].result.code].sort();
      assert.ok(reserveCodes.includes('converted') || reserveCodes.includes('not_active') || reserveCodes.includes('already_reserved'));
    } finally {
      await a.end();
      await b.end();
    }
  });
});
