/**
 * POST /api/crm/funnel/ingest — funnel analytics intake.
 *
 * Receives batches of anonymous funnel events from funnel workers (a funnel
 * site proxies browser beacons here server-to-server). The
 * client already dedupes each event per session, so the dashboard can count
 * rows per step as distinct sessions — this endpoint just validates and stores.
 *
 * Auth: x-funnel-secret header (crm_funnel_secret setting) or standard API auth.
 * Body: { funnel?, events: [{ session_id, event_type, event_data?, page_url?,
 *         referrer?, funnel? }] } — per-event funnel wins over the batch value.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateFunnelIngest } from "@/lib/crm/capture-auth";
import type { Database } from "@/types/database";

type FunnelEventInsert = Database["public"]["Tables"]["funnel_events"]["Insert"];

const EVENT_TYPES = new Set(["start", "view", "complete", "cta_click"]);
const MAX_EVENTS_PER_BATCH = 100;

const str = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null;

function toRow(raw: unknown, batchFunnel: string | null): FunnelEventInsert | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;

  const session_id = str(e.session_id, 100);
  const event_type = str(e.event_type, 40);
  if (!session_id || !event_type || !EVENT_TYPES.has(event_type)) return null;

  const data =
    e.event_data && typeof e.event_data === "object" && !Array.isArray(e.event_data)
      ? (e.event_data as Record<string, unknown>)
      : {};

  // Lift the step position out of event_data into real columns so the
  // dashboard can aggregate without JSON digging; the rest stays as-is.
  const idx = typeof data.screen_index === "number" && Number.isFinite(data.screen_index) ? data.screen_index : null;

  return {
    funnel: str(e.funnel, 80) ?? batchFunnel ?? "unknown",
    session_id,
    event_type,
    screen_index: idx !== null ? Math.max(0, Math.min(999, Math.floor(idx))) : null,
    screen_id: str(data.screen_id, 80),
    event_data: JSON.parse(JSON.stringify(data)),
    page_url: str(e.page_url, 500),
    referrer: str(e.referrer, 500),
  };
}

export async function POST(request: NextRequest) {
  const supabase = createAdminClient();

  const auth = await authenticateFunnelIngest(request, supabase);
  if (!auth.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const batchFunnel = str(body.funnel, 80);
  const rawEvents = Array.isArray(body.events) ? body.events : [body];
  const rows = rawEvents
    .slice(0, MAX_EVENTS_PER_BATCH)
    .map((e) => toRow(e, batchFunnel))
    .filter((r): r is FunnelEventInsert => r !== null);

  if (rows.length === 0) {
    return NextResponse.json({ ok: true, inserted: 0 });
  }

  const { error } = await supabase.from("funnel_events").insert(rows);
  if (error) {
    console.error("[funnel/ingest] insert failed:", error.message);
    return NextResponse.json({ error: "insert failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}
