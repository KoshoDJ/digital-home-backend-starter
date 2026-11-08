import { createHash } from "crypto";

export const CORNERMAN_SOURCE = "cornerman";
export const CORNERMAN_SCHEMA_VERSION = 1;
export const CORNERMAN_CONVERSION_STATUS = "enrolled";
export const DEFAULT_CONVERSION_MAX_FUTURE_SKEW_SECONDS = 300;
const ISO_8601_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CONVERSION_FIELDS = [
  "schema_version",
  "event_id",
  "source",
  "environment",
  "occurred_at",
  "digital_home_lead_id",
  "cornerman_enrollment_id",
  "cornerman_enrollment_version",
  "correlation_id",
  "conversion_status",
] as const;

export type ConversionPayload = {
  schema_version: typeof CORNERMAN_SCHEMA_VERSION;
  event_id: string;
  source: typeof CORNERMAN_SOURCE;
  environment: string;
  occurred_at: string;
  digital_home_lead_id: string;
  cornerman_enrollment_id: string;
  cornerman_enrollment_version: number;
  correlation_id: string;
  conversion_status: typeof CORNERMAN_CONVERSION_STATUS;
};

export type ConversionReceipt = {
  id: string;
  producer: string;
  environment: string;
  event_id: string;
  schema_version: number;
  payload_hash: string;
  digital_home_lead_id: string;
  cornerman_enrollment_id: string;
  cornerman_enrollment_version: number;
  correlation_id: string;
  received_at: string;
  applied_at: string | null;
  result_status: "applied" | "needs_review" | "pending";
  prospect_nurture_exited: number;
  in_flight_reservations: number;
  diagnostics: Record<string, unknown>;
};

const RECEIPT_KEYS: (keyof ConversionReceipt)[] = [
  "id",
  "producer",
  "environment",
  "event_id",
  "schema_version",
  "payload_hash",
  "digital_home_lead_id",
  "cornerman_enrollment_id",
  "cornerman_enrollment_version",
  "correlation_id",
  "received_at",
  "applied_at",
  "result_status",
  "prospect_nurture_exited",
  "in_flight_reservations",
  "diagnostics",
];

const PRIVATE_KEY_HINTS = /email|name|phone|message|body|secret|api[_-]?key|signature|token/i;

export type ParseFailure = { ok: false; error: string };
export type ParseSuccess = { ok: true; payload: ConversionPayload; payloadHash: string };

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function conversionMaxFutureSkewSeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.CORNERMAN_CONVERSION_MAX_FUTURE_SKEW_SECONDS || DEFAULT_CONVERSION_MAX_FUTURE_SKEW_SECONDS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONVERSION_MAX_FUTURE_SKEW_SECONDS;
}

function isIso8601Timestamp(value: string): boolean {
  return ISO_8601_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

export function configuredIntegrationEnv(env: Record<string, string | undefined> = process.env): string | null {
  const value = env.DIGITAL_HOME_INTEGRATION_ENV;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function canonicalPayloadHash(payload: ConversionPayload): string {
  const canonical: Record<string, unknown> = {};
  for (const key of CONVERSION_FIELDS) canonical[key] = payload[key];
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function parseConversionPayload(
  body: unknown,
  nowMs = Date.now(),
  env: Record<string, string | undefined> = process.env
): ParseSuccess | ParseFailure {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid request" };
  }
  const input = body as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.length !== CONVERSION_FIELDS.length || keys.some((key) => !CONVERSION_FIELDS.includes(key as (typeof CONVERSION_FIELDS)[number]))) {
    return { ok: false, error: "Invalid request" };
  }
  if (input.schema_version !== CORNERMAN_SCHEMA_VERSION) {
    return { ok: false, error: "Invalid request" };
  }
  if (input.source !== CORNERMAN_SOURCE) {
    return { ok: false, error: "Invalid request" };
  }
  if (input.conversion_status !== CORNERMAN_CONVERSION_STATUS) {
    return { ok: false, error: "Invalid request" };
  }
  if (typeof input.environment !== "string" || !input.environment.trim()) {
    return { ok: false, error: "Invalid request" };
  }
  if (
    !isUuid(input.event_id) ||
    !isUuid(input.digital_home_lead_id) ||
    !isUuid(input.cornerman_enrollment_id) ||
    !isUuid(input.correlation_id)
  ) {
    return { ok: false, error: "Invalid request" };
  }
  if (
    typeof input.cornerman_enrollment_version !== "number" ||
    !Number.isInteger(input.cornerman_enrollment_version) ||
    input.cornerman_enrollment_version < 1
  ) {
    return { ok: false, error: "Invalid request" };
  }
  if (typeof input.occurred_at !== "string" || !isIso8601Timestamp(input.occurred_at)) {
    return { ok: false, error: "Invalid request" };
  }
  const occurredAt = Date.parse(input.occurred_at);
  const skewMs = conversionMaxFutureSkewSeconds(env) * 1000;
  if (occurredAt - nowMs > skewMs) {
    return { ok: false, error: "Invalid request" };
  }

  const payload: ConversionPayload = {
    schema_version: CORNERMAN_SCHEMA_VERSION,
    event_id: input.event_id,
    source: CORNERMAN_SOURCE,
    environment: input.environment.trim(),
    occurred_at: input.occurred_at,
    digital_home_lead_id: input.digital_home_lead_id,
    cornerman_enrollment_id: input.cornerman_enrollment_id,
    cornerman_enrollment_version: input.cornerman_enrollment_version,
    correlation_id: input.correlation_id,
    conversion_status: CORNERMAN_CONVERSION_STATUS,
  };
  return { ok: true, payload, payloadHash: canonicalPayloadHash(payload) };
}

export function publicReceipt(row: Record<string, unknown>): ConversionReceipt | null {
  const receipt: Record<string, unknown> = {};
  for (const key of RECEIPT_KEYS) {
    if (!(key in row)) return null;
    receipt[key] = row[key];
  }
  if (Object.keys(row).some((key) => PRIVATE_KEY_HINTS.test(key))) return null;
  const diagnostics = receipt.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    if (Object.keys(diagnostics).some((key) => PRIVATE_KEY_HINTS.test(key))) return null;
  }
  return receipt as ConversionReceipt;
}

export function receiptContainsPrivateData(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const visit = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return false;
    if (Array.isArray(node)) return node.some(visit);
    return Object.entries(node as Record<string, unknown>).some(([key, nested]) => {
      if (PRIVATE_KEY_HINTS.test(key)) return true;
      if (typeof nested === "string" && /@/.test(nested) && nested.includes(".")) return true;
      return visit(nested);
    });
  };
  return visit(value);
}
