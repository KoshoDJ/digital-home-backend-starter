/**
 * POST /api/crm/webhooks/calcom — Cal.com booking events.
 *
 * Configure in Cal.com: Settings → Developer → Webhooks → new webhook with
 * subscriber URL https://backend.yourdomain.com/api/crm/webhooks/calcom,
 * events BOOKING_CREATED + BOOKING_RESCHEDULED + BOOKING_CANCELLED, and the
 * same secret as `wrangler secret put CALCOM_WEBHOOK_SECRET`.
 *
 * Signature: x-cal-signature-256 = hex HMAC-SHA256 of the raw body.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { processCalcomEvent, type CalBookingPayload } from "@/lib/crm/bookings";

function verifySignature(secret: string, body: string, signature: string): boolean {
  try {
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature.trim().toLowerCase());
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const secret = process.env.CALCOM_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CALCOM_WEBHOOK_SECRET not configured" }, { status: 501 });
  }

  const body = await request.text();
  const signature = request.headers.get("x-cal-signature-256") || "";
  if (!verifySignature(secret, body, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { triggerEvent?: string; payload?: CalBookingPayload };
  try {
    event = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!event.triggerEvent || !event.payload) {
    return NextResponse.json({ error: "Missing triggerEvent or payload" }, { status: 400 });
  }

  try {
    const supabase = createAdminClient();
    const result = await processCalcomEvent(supabase, event.triggerEvent, event.payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : "calcom webhook failed";
    console.error("calcom webhook:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
