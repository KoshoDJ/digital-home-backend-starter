import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';

const sql = (name) => readFileSync(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8');
const FILES = [
  '001_backend_core.sql',
  '002_crm_core.sql',
  '003_schema_migrations.sql',
  '004_agent_keys.sql',
  '005_home_events.sql',
  '006_money.sql',
  '007_payment_receipts.sql',
  '008_agent_approvals.sql',
  '900_cornerman_conversion.sql',
];
const EVENT = '11111111-1111-4111-8111-111111111111';
const ENROLL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CORR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function hash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function open() {
  const db = new PGlite({ extensions: { uuid_ossp } });
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema storage; create table storage.buckets(id text primary key, name text, public boolean);
    create table storage.objects(id uuid primary key, bucket_id text);`);
  await db.exec(readFileSync(new URL('./fixtures/frontend-2.5.4.sql', import.meta.url), 'utf8'));
  for (const file of FILES) await db.exec(sql(file));
  return db;
}

async function seed(db, purposes = ['prospect_nurture', 'general', 'customer_onboarding', 'transactional']) {
  const lead = (await db.query("insert into leads(email, first_name) values('fixture@example.test','Pat') returning id")).rows[0].id;
  const workflows = {};
  for (const purpose of purposes) {
    workflows[purpose] = (await db.query(
      'insert into workflows(name, status, purpose, steps) values($1,$2,$3,$4) returning id',
      [purpose, 'active', purpose, '[]']
    )).rows[0].id;
    await db.query(
      'insert into workflow_enrollments(workflow_id, lead_id, status, current_step) values($1,$2,$3,0)',
      [workflows[purpose], lead, 'active']
    );
  }
  return { lead, workflows };
}

async function convert(db, lead, payloadHash = hash({ lead }), eventId = EVENT) {
  return (await db.query(
    'select public.apply_cornerman_conversion_v1($1,$2,$3,$4,$5,$6,$7,$8,$9) as result',
    ['cornerman', 'staging', eventId, 1, payloadHash, lead, ENROLL, 1, CORR]
  )).rows[0].result;
}

test('existing workflows default to general and conversion exits only prospect nurture', async () => {
  const db = await open();
  try {
    const { lead } = await seed(db);
    const purpose = (await db.query('select purpose from workflows order by name')).rows.map((row) => row.purpose);
    assert.deepEqual(purpose.sort(), ['customer_onboarding', 'general', 'prospect_nurture', 'transactional']);
    const first = await convert(db, lead);
    assert.equal(first.ok, true);
    assert.equal(first.code, 'applied');
    assert.equal(first.receipt.result_status, 'applied');
    assert.equal(first.receipt.prospect_nurture_exited, 1);
    assert.equal(first.receipt.in_flight_reservations, 0);
    const enrollments = await db.query(
      `select w.purpose, e.status, e.exit_reason, e.exit_event_id is not null as has_event
       from workflow_enrollments e join workflows w on w.id = e.workflow_id order by w.purpose`
    );
    const byPurpose = Object.fromEntries(enrollments.rows.map((row) => [row.purpose, row]));
    assert.equal(byPurpose.prospect_nurture.status, 'exited');
    assert.equal(byPurpose.prospect_nurture.exit_reason, 'cornerman_conversion');
    assert.equal(byPurpose.prospect_nurture.has_event, true);
    assert.equal(byPurpose.general.status, 'active');
    assert.equal(byPurpose.customer_onboarding.status, 'active');
    assert.equal(byPurpose.transactional.status, 'active');
    assert.equal((await db.query('select status from leads')).rows[0].status, 'converted');
    const replay = await convert(db, lead);
    assert.equal(replay.code, 'replay');
    assert.equal(replay.receipt.id, first.receipt.id);
    assert.equal((await db.query("select count(*)::int as n from lead_activities where activity_type='status_changed'")).rows[0].n, 1);
    const conflict = await convert(db, lead, hash({ other: true }));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.code, 'conflict');
    const missing = await convert(db, '99999999-9999-4999-8999-999999999999', hash({ missing: true }), '55555555-5555-4555-8555-555555555555');
    assert.equal(missing.code, 'not_found');
    const keys = Object.keys(first.receipt).join(' ');
    assert.equal(/email|phone|message|secret|api_key/i.test(keys), false);
  } finally {
    await db.close();
  }
});

test('completed failed and already exited enrollments stay unchanged', async () => {
  const db = await open();
  try {
    const { lead, workflows } = await seed(db, ['prospect_nurture']);
    await db.query("update workflow_enrollments set status='completed'");
    const completed = await convert(db, lead, hash({ done: true }), '66666666-6666-4666-8666-666666666666');
    assert.equal(completed.receipt.prospect_nurture_exited, 0);
    assert.equal((await db.query('select status from workflow_enrollments')).rows[0].status, 'completed');
    await db.query("update workflow_enrollments set status='failed'");
    const failed = await convert(db, lead, hash({ fail: true }), '77777777-7777-4777-8777-777777777777');
    assert.equal(failed.receipt.prospect_nurture_exited, 0);
    await db.query(
      "update workflow_enrollments set status='exited', exit_reason='archived'"
    );
    const exited = await convert(db, lead, hash({ exit: true }), '88888888-8888-4888-8888-888888888888');
    assert.equal(exited.receipt.prospect_nurture_exited, 0);
    assert.equal((await db.query('select exit_reason from workflow_enrollments')).rows[0].exit_reason, 'archived');
    assert.ok(workflows.prospect_nurture);
  } finally {
    await db.close();
  }
});

test('a reserved dispatch makes conversion report needs_review and a converted lead cannot reserve', async () => {
  const db = await open();
  try {
    const { lead, workflows } = await seed(db, ['prospect_nurture']);
    const enrollment = (await db.query('select id from workflow_enrollments')).rows[0].id;
    const reserved = (await db.query(
      'select public.reserve_workflow_dispatch_v1($1,0,600) as result',
      [enrollment]
    )).rows[0].result;
    assert.equal(reserved.ok, true);
    const result = await convert(db, lead, hash({ race: true }), '12121212-1212-4121-8121-121212121212');
    assert.equal(result.code, 'needs_review');
    assert.equal(result.receipt.in_flight_reservations, 1);
    const blocked = (await db.query(
      'select public.reserve_workflow_dispatch_v1($1,0,600) as result',
      [enrollment]
    )).rows[0].result;
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'converted');
    assert.ok(workflows.prospect_nurture);
  } finally {
    await db.close();
  }
});

test('failed reservations are not in flight, can be recovered, and sent outcomes stay immutable', async () => {
  const db = await open();
  try {
    const first = await seed(db, ['prospect_nurture']);
    const enrollment = (await db.query('select id from workflow_enrollments where lead_id=$1', [first.lead])).rows[0].id;
    const reserved = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment])).rows[0].result;
    const failed = (await db.query('select public.complete_workflow_dispatch_v1($1,$2) as result', [reserved.reservation_id, 'failed'])).rows[0].result;
    assert.equal(failed.code, 'failed');
    const converted = await convert(db, first.lead, hash({ failed: true }), '13131313-1313-4131-8131-131313131313');
    assert.equal(converted.code, 'applied');
    assert.equal(converted.receipt.in_flight_reservations, 0);

    const retryLead = (await db.query("insert into leads(email, first_name) values('retry@example.test','Ray') returning id")).rows[0].id;
    const retryEnrollment = (await db.query(
      'insert into workflow_enrollments(workflow_id, lead_id, status, current_step) values($1,$2,$3,0) returning id',
      [first.workflows.prospect_nurture, retryLead, 'active']
    )).rows[0].id;
    const retryReserved = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [retryEnrollment])).rows[0].result;
    await db.query('select public.complete_workflow_dispatch_v1($1,$2)', [retryReserved.reservation_id, 'failed']);
    const recovered = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [retryEnrollment])).rows[0].result;
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
    await db.query('select public.complete_workflow_dispatch_v1($1,$2)', [recovered.reservation_id, 'simulated']);
    const immutable = (await db.query('select public.complete_workflow_dispatch_v1($1,$2) as result', [recovered.reservation_id, 'failed'])).rows[0].result;
    assert.equal(immutable.code, 'already_dispatched');
    assert.equal(
      (await db.query('select status from workflow_dispatch_reservations where id=$1', [recovered.reservation_id])).rows[0].status,
      'simulated'
    );
    const again = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [retryEnrollment])).rows[0].result;
    assert.equal(again.code, 'already_dispatched');
  } finally {
    await db.close();
  }
});

test('deleting a converted lead removes receipts, exited enrollments, and reservations', async () => {
  const db = await open();
  try {
    const { lead } = await seed(db, ['prospect_nurture']);
    const enrollment = (await db.query('select id from workflow_enrollments')).rows[0].id;
    const reserved = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment])).rows[0].result;
    assert.equal(reserved.ok, true);
    const result = await convert(db, lead, hash({ delete: true }), '14141414-1414-4141-8141-141414141414');
    assert.equal(result.code, 'needs_review');
    assert.equal((await db.query('select count(*)::int as n from conversion_receipts')).rows[0].n, 1);
    assert.equal((await db.query("select status from workflow_enrollments")).rows[0].status, 'exited');
    assert.equal((await db.query('select count(*)::int as n from workflow_dispatch_reservations')).rows[0].n, 1);
    await db.query('delete from leads where id = $1', [lead]);
    assert.equal((await db.query('select count(*)::int as n from leads')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from conversion_receipts')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from workflow_enrollments')).rows[0].n, 0);
    assert.equal((await db.query('select count(*)::int as n from workflow_dispatch_reservations')).rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test('stale reservations can be recovered and already dispatched steps are not reserved again', async () => {
  const db = await open();
  try {
    const { lead, workflows } = await seed(db, ['prospect_nurture']);
    const enrollment = (await db.query('select id from workflow_enrollments')).rows[0].id;
    const first = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,1) as result', [enrollment])).rows[0].result;
    await db.query("update workflow_dispatch_reservations set expires_at = now() - interval '1 second'");
    const recovered = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment])).rows[0].result;
    assert.equal(recovered.ok, true);
    assert.equal(recovered.recovered, true);
    await db.query('select public.complete_workflow_dispatch_v1($1,$2)', [recovered.reservation_id, 'simulated']);
    const again = (await db.query('select public.reserve_workflow_dispatch_v1($1,0,600) as result', [enrollment])).rows[0].result;
    assert.equal(again.code, 'already_dispatched');
    assert.equal((await db.query('select count(*)::int as n from workflow_dispatch_reservations')).rows[0].n, 1);
    assert.ok(lead && workflows.prospect_nurture && first.ok);
  } finally {
    await db.close();
  }
});
