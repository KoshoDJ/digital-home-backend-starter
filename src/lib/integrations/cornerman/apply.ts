import type { AdminClient } from "@/lib/crm/types";
import type { ConversionPayload, ConversionReceipt } from "./contract.ts";
import { publicReceipt } from "./contract.ts";

export type ApplyResult =
  | { ok: true; status: number; code: "applied" | "needs_review" | "replay"; receipt: ConversionReceipt }
  | { ok: false; status: number; error: string };

type RpcRow = {
  ok?: boolean;
  code?: string;
  receipt?: Record<string, unknown>;
};

export async function applyCornermanConversion(
  supabase: AdminClient,
  payload: ConversionPayload,
  payloadHash: string
): Promise<ApplyResult> {
  const { data, error } = await supabase.rpc("apply_cornerman_conversion_v1", {
    p_producer: payload.source,
    p_environment: payload.environment,
    p_event_id: payload.event_id,
    p_schema_version: payload.schema_version,
    p_payload_hash: payloadHash,
    p_lead_id: payload.digital_home_lead_id,
    p_cornerman_enrollment_id: payload.cornerman_enrollment_id,
    p_cornerman_enrollment_version: payload.cornerman_enrollment_version,
    p_correlation_id: payload.correlation_id,
  });
  if (error) {
    return { ok: false, status: 500, error: "Conversion could not be applied" };
  }
  const row = (data ?? {}) as RpcRow;
  if (row.ok === false && row.code === "not_found") {
    return { ok: false, status: 404, error: "Not found" };
  }
  if (row.ok === false && row.code === "conflict") {
    return { ok: false, status: 409, error: "Conflicting conversion event" };
  }
  if (!row.ok || !row.receipt || !row.code) {
    return { ok: false, status: 500, error: "Conversion could not be applied" };
  }
  const receipt = publicReceipt(row.receipt);
  if (!receipt) {
    return { ok: false, status: 500, error: "Conversion could not be applied" };
  }
  if (row.code === "replay") {
    return { ok: true, status: 200, code: "replay", receipt };
  }
  if (row.code === "applied" || row.code === "needs_review") {
    return { ok: true, status: 200, code: row.code, receipt };
  }
  return { ok: false, status: 500, error: "Conversion could not be applied" };
}

export async function readCornermanConversion(
  supabase: AdminClient,
  eventId: string,
  environment: string
): Promise<ConversionReceipt | null> {
  const { data, error } = await supabase
    .from("conversion_receipts")
    .select(
      "id, producer, environment, event_id, schema_version, payload_hash, digital_home_lead_id, cornerman_enrollment_id, cornerman_enrollment_version, correlation_id, received_at, applied_at, result_status, prospect_nurture_exited, in_flight_reservations, diagnostics"
    )
    .eq("producer", "cornerman")
    .eq("environment", environment)
    .eq("event_id", eventId)
    .maybeSingle();
  if (error || !data) return null;
  return publicReceipt(data as Record<string, unknown>);
}
