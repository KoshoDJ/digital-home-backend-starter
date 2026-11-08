import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalPayloadHash,
  parseConversionPayload,
  publicReceipt,
  receiptContainsPrivateData,
} from "./contract.ts";

const EVENT = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const ENROLL = "33333333-3333-4333-8333-333333333333";
const CORR = "44444444-4444-4444-8444-444444444444";

function valid(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    event_id: EVENT,
    source: "cornerman",
    environment: "staging",
    occurred_at: new Date().toISOString(),
    digital_home_lead_id: LEAD,
    cornerman_enrollment_id: ENROLL,
    cornerman_enrollment_version: 1,
    correlation_id: CORR,
    conversion_status: "enrolled",
    ...overrides,
  };
}

test("a valid Digital Home lead UUID payload is accepted and hashed canonically", () => {
  const parsed = parseConversionPayload(valid(), Date.now(), { DIGITAL_HOME_INTEGRATION_ENV: "staging" });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.payload.digital_home_lead_id, LEAD);
  assert.equal(parsed.payloadHash, canonicalPayloadHash(parsed.payload));
});

test("unknown fields, email identity, and invalid contract values are rejected", () => {
  const env = { CORNERMAN_CONVERSION_MAX_FUTURE_SKEW_SECONDS: "300" };
  const now = Date.now();
  assert.equal(parseConversionPayload({ ...valid(), email: "lead@example.test" }, now, env).ok, false);
  assert.equal(parseConversionPayload({ ...valid(), schema_version: 2 }, now, env).ok, false);
  assert.equal(parseConversionPayload({ ...valid(), source: "other" }, now, env).ok, false);
  assert.equal(parseConversionPayload({ ...valid(), conversion_status: "paid" }, now, env).ok, false);
  const missingLead = { ...valid() } as Record<string, unknown>;
  delete missingLead.digital_home_lead_id;
  assert.equal(parseConversionPayload(missingLead, now, env).ok, false);
});

test("historical occurred_at values are accepted and only unreasonable future skew is rejected", () => {
  const env = { CORNERMAN_CONVERSION_MAX_FUTURE_SKEW_SECONDS: "300" };
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const dayOld = valid({ occurred_at: new Date(now - 24 * 60 * 60_000).toISOString() });
  const monthOld = valid({ occurred_at: new Date(now - 30 * 24 * 60 * 60_000).toISOString() });
  const withinSkew = valid({ occurred_at: new Date(now + 300_000).toISOString() });
  const beyondSkew = valid({ occurred_at: new Date(now + 301_000).toISOString() });
  assert.equal(parseConversionPayload(dayOld, now, env).ok, true);
  assert.equal(parseConversionPayload(monthOld, now, env).ok, true);
  assert.equal(parseConversionPayload(withinSkew, now, env).ok, true);
  assert.equal(parseConversionPayload(beyondSkew, now, env).ok, false);
});

test("an identical body can replay after the old five-minute payload window, but a changed occurred_at conflicts", () => {
  const env = { CORNERMAN_CONVERSION_MAX_FUTURE_SKEW_SECONDS: "300" };
  const occurredAt = "2026-11-07T12:00:00.000Z";
  const body = valid({ occurred_at: occurredAt });
  const first = parseConversionPayload(body, Date.parse("2026-11-07T12:00:30.000Z"), env);
  const later = parseConversionPayload(body, Date.parse("2026-11-07T12:10:00.000Z"), env);
  assert.equal(first.ok, true);
  assert.equal(later.ok, true);
  if (!first.ok || !later.ok) return;
  assert.equal(first.payloadHash, later.payloadHash);
  assert.equal(first.payload.occurred_at, occurredAt);
  const mutated = parseConversionPayload(valid({ occurred_at: "2026-11-07T12:00:01.000Z" }), Date.parse("2026-11-07T12:10:00.000Z"), env);
  assert.equal(mutated.ok, true);
  if (!mutated.ok) return;
  assert.notEqual(mutated.payloadHash, first.payloadHash);
});

test("missing, malformed, and non-ISO occurred_at values are rejected", () => {
  const now = Date.parse("2026-11-08T12:00:00.000Z");
  const env = { CORNERMAN_CONVERSION_MAX_FUTURE_SKEW_SECONDS: "300" };
  const missing = { ...valid() } as Record<string, unknown>;
  delete missing.occurred_at;
  assert.equal(parseConversionPayload(missing, now, env).ok, false);
  assert.equal(parseConversionPayload(valid({ occurred_at: "not-a-date" }), now, env).ok, false);
  assert.equal(parseConversionPayload(valid({ occurred_at: "December 17, 1995 03:24:00" }), now, env).ok, false);
  assert.equal(parseConversionPayload(valid({ occurred_at: 1730000000 }), now, env).ok, false);
  assert.equal(parseConversionPayload(valid({ occurred_at: "2026-11-08" }), now, env).ok, false);
});

test("receipt projection keeps only non-PII conversion fields", () => {
  const receipt = publicReceipt({
    id: EVENT,
    producer: "cornerman",
    environment: "staging",
    event_id: EVENT,
    schema_version: 1,
    payload_hash: "abc",
    digital_home_lead_id: LEAD,
    cornerman_enrollment_id: ENROLL,
    cornerman_enrollment_version: 1,
    correlation_id: CORR,
    received_at: new Date().toISOString(),
    applied_at: new Date().toISOString(),
    result_status: "applied",
    prospect_nurture_exited: 1,
    in_flight_reservations: 0,
    diagnostics: { exit_reason: "cornerman_conversion" },
  });
  assert.ok(receipt);
  assert.equal(receiptContainsPrivateData(receipt), false);
  assert.equal(publicReceipt({ ...receipt, email: "lead@example.test" }), null);
  assert.equal(receiptContainsPrivateData({ receipt, email: "lead@example.test" }), true);
});
