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
const pgBin = (name, args = []) => execFileSync(join(binaries, name), args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const sqlFile = (name) => readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const FILES = [
  '001_backend_core.sql', '002_crm_core.sql', '003_schema_migrations.sql', '004_agent_keys.sql',
  '005_home_events.sql', '006_money.sql', '007_payment_receipts.sql', '008_agent_approvals.sql',
  '900_cornerman_conversion.sql',
];
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function withCluster(run) {
  const root = realpathSync(mkdtempSync('/tmp/dh-cornerman-'));
  chmodSync(root, 0o700);
  const data = join(root, 'cluster');
  const socket = join(root, 'socket');
  mkdirSync(socket, { mode: 0o700 });
  const port = 55000 + Math.floor(Math.random() * 2000);
  const connect = () => new pg.Client({ host: socket, port, user: 'conversion_test', database: 'conversion' });
  pgBin('initdb', ['-D', data, '-U', 'conversion_test', '-A', 'trust', '--encoding=UTF8', '--no-locale']);
  pgBin('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h '' -k ${socket} -p ${port}`, '-w', 'start']);
  try {
    pgBin('createdb', ['-h', socket, '-p', String(port), '-U', 'conversion_test', 'conversion']);
    const admin = connect();
    await admin.connect();
    await admin.query(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema storage; create table storage.buckets(id text primary key, name text, public boolean);
      create table storage.objects(id uuid primary key, bucket_id text);
      create extension if not exists "uuid-ossp";`);
    await admin.query(readFileSync(new URL('./fixtures/frontend-2.5.4.sql', import.meta.url), 'utf8'));
    for (const file of FILES) await admin.query(sqlFile(file));
    await run(admin, connect);
    await admin.end();
  } finally {
    try { pgBin('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); } catch { /* already stopped */ }
    rmSync(root, { recursive: true, force: true });
  }
}

async function seed(db, label = 'race') {
  const lead = (await db.query(
    "insert into leads(email, first_name) values($1,'Pat') returning id",
    [`${label}@example.test`]
  )).rows[0].id;
  const workflow = (await db.query(
    "insert into workflows(name, status, purpose, steps) values($1,'active','prospect_nurture','[]') returning id",
    [`nurture-${label}`]
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
  await withCluster(async (admin, connect) => {
    const { lead, enrollment } = await seed(admin);
    const a = connect();
    const b = connect();
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

async function waitUntilLockWait(admin, pid) {
  for (let i = 0; i < 150; i++) {
    const { rows } = await admin.query(
      'select wait_event_type from pg_stat_activity where pid = $1',
      [pid]
    );
    if (rows[0]?.wait_event_type === 'Lock') return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${pid} did not wait on a lock`);
}

test('overlapping conversion and reservation transactions serialize without deadlock', async () => {
  await withCluster(async (admin, connect) => {
    const a = connect();
    const b = connect();
    await a.connect();
    await b.connect();
    try {
      for (const conn of [a, b]) {
        await conn.query("set lock_timeout = '5s'");
        await conn.query("set deadlock_timeout = '200ms'");
      }

      const conversionFirst = await seed(admin, 'convert-first');
      const reservePid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
      await a.query('begin');
      await a.query('select id from leads where id = $1 for update', [conversionFirst.lead]);
      const blockedReserve = b.query(
        'select public.reserve_workflow_dispatch_v1($1,0,600) as result',
        [conversionFirst.enrollment]
      );
      await waitUntilLockWait(admin, reservePid);
      const convertedFirst = await convert(
        a,
        conversionFirst.lead,
        { lead: conversionFirst.lead },
        '55555555-5555-4555-8555-555555555555'
      );
      await a.query('commit');
      const reserveAfter = (await blockedReserve).rows[0].result;
      assert.equal(convertedFirst.ok, true);
      assert.equal(convertedFirst.code, 'applied');
      assert.equal(reserveAfter.ok, false);
      assert.ok(['converted', 'not_active'].includes(reserveAfter.code));
      assert.equal(
        (await admin.query('select count(*)::int as n from conversion_receipts where event_id=$1', [
          '55555555-5555-4555-8555-555555555555',
        ])).rows[0].n,
        1
      );

      const reservationFirst = await seed(admin, 'reserve-first');
      const convertPid = (await b.query('select pg_backend_pid() as pid')).rows[0].pid;
      await a.query('begin');
      await a.query('select id from leads where id = $1 for update', [reservationFirst.lead]);
      const blockedConvert = convert(
        b,
        reservationFirst.lead,
        { lead: reservationFirst.lead },
        '66666666-6666-4666-8666-666666666666'
      );
      await waitUntilLockWait(admin, convertPid);
      const reservedFirst = (await a.query(
        'select public.reserve_workflow_dispatch_v1($1,0,600) as result',
        [reservationFirst.enrollment]
      )).rows[0].result;
      await a.query('commit');
      const convertAfter = await blockedConvert;
      assert.equal(reservedFirst.ok, true);
      assert.equal(reservedFirst.code, 'reserved');
      assert.equal(convertAfter.ok, true);
      assert.equal(convertAfter.code, 'needs_review');
      assert.equal(convertAfter.receipt.in_flight_reservations, 1);
    } finally {
      await a.end();
      await b.end();
    }
  });
});
