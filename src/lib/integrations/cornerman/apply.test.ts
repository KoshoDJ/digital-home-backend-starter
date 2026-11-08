import assert from "node:assert/strict";
import test from "node:test";
import { applyCornermanConversion, readCornermanConversion } from "./apply.ts";
import type { ConversionPayload } from "./contract.ts";

const payload: ConversionPayload = {
  schema_version: 1,
  event_id: "11111111-1111-4111-8111-111111111111",
  source: "cornerman",
  environment: "staging",
  occurred_at: new Date().toISOString(),
  digital_home_lead_id: "22222222-2222-4222-8222-222222222222",
  cornerman_enrollment_id: "33333333-3333-4333-8333-333333333333",
  cornerman_enrollment_version: 1,
  correlation_id: "44444444-4444-4444-8444-444444444444",
  conversion_status: "enrolled",
};

function receipt() {
  return {
    id: "55555555-5555-4555-8555-555555555555",
    producer: "cornerman",
    environment: "staging",
    event_id: payload.event_id,
    schema_version: 1,
    payload_hash: "abc",
    digital_home_lead_id: payload.digital_home_lead_id,
    cornerman_enrollment_id: payload.cornerman_enrollment_id,
    cornerman_enrollment_version: 1,
    correlation_id: payload.correlation_id,
    received_at: "2026-01-01T00:00:00Z",
    applied_at: "2026-01-01T00:00:00Z",
    result_status: "applied",
    prospect_nurture_exited: 1,
    in_flight_reservations: 0,
    diagnostics: { exit_reason: "cornerman_conversion" },
  };
}

function rpc(data: unknown, error: unknown = null) {
  return {
    rpc: async () => ({ data, error }),
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data, error }),
            }),
          }),
        }),
      }),
    }),
  };
}

test("RPC not_found and conflict map to generic HTTP failures, never a success", async () => {
  assert.deepEqual(await applyCornermanConversion(rpc({ ok: false, code: "not_found" }) as never, payload, "h"), {
    ok: false,
    status: 404,
    error: "Not found",
  });
  assert.equal((await applyCornermanConversion(rpc({ ok: false, code: "conflict" }) as never, payload, "h")).status, 409);
  assert.equal((await applyCornermanConversion(rpc(null, { message: "db" }) as never, payload, "h")).status, 500);
});

test("applied and identical replay return the public receipt", async () => {
  const applied = await applyCornermanConversion(rpc({ ok: true, code: "applied", receipt: receipt() }) as never, payload, "h");
  assert.equal(applied.ok, true);
  if (applied.ok) {
    assert.equal(applied.code, "applied");
    assert.equal(applied.receipt.digital_home_lead_id, payload.digital_home_lead_id);
  }
  const replay = await applyCornermanConversion(rpc({ ok: true, code: "replay", receipt: receipt() }) as never, payload, "h");
  assert.equal(replay.ok, true);
  if (replay.ok) assert.equal(replay.code, "replay");
  const found = await readCornermanConversion(rpc(receipt()) as never, payload.event_id, "staging");
  assert.equal(found?.event_id, payload.event_id);
  assert.equal(found && "email" in found, false);
});
