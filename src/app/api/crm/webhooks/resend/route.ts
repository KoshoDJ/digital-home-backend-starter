/**
 * POST /api/crm/webhooks/resend — Resend delivery events (svix-signed).
 * Configure in Resend: Webhooks → add endpoint → this URL, then
 * `wrangler secret put RESEND_WEBHOOK_SECRET` with the whsec_ value.
 *
 * Maps delivered/opened/clicked/bounced/complained onto email_sends +
 * email_events, and flips lead email_status on bounces/complaints so
 * the suppression check stops future sends automatically.
 */
import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/crm/activity";

function verifySvix(secret: string, id: string, timestamp: string, payload: string, signatureHeader: string): boolean {
  try {
    const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signedContent = `${id}.${timestamp}.${payload}`;
    const expected = createHmac("sha256", secretBytes).update(signedContent).digest("base64");
    // Header format: "v1,<base64sig> v1,<base64sig2> ..."
    for (const part of signatureHeader.split(" ")) {
      const [, sig] = part.split(",");
      if (!sig) continue;
      const a = Buffer.from(expected);
      const b = Buffer.from(sig);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    }
  } catch {
    return false;
  }
  return false;
}

const EVENT_MAP: Record<string, "delivered" | "opened" | "clicked" | "bounced" | "complained"> = {
  "email.delivered": "delivered",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
};

export async function POST(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "RESEND_WEBHOOK_SECRET not configured" }, { status: 501 });
  }

  const payload = await request.text();
  const svixId = request.headers.get("svix-id") || "";
  const svixTimestamp = request.headers.get("svix-timestamp") || "";
  const svixSignature = request.headers.get("svix-signature") || "";

  if (!verifySvix(secret, svixId, svixTimestamp, payload, svixSignature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let event: { type?: string; data?: { email_id?: string; click?: { link?: string } } };
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const mapped = EVENT_MAP[event.type || ""];
  const resendId = event.data?.email_id;
  if (!mapped || !resendId) return NextResponse.json({ ok: true, ignored: true });

  const supabase = createAdminClient();
  const { data: send } = await supabase
    .from("email_sends")
    .select("id, lead_id, subject, opened_at, clicked_at")
    .eq("resend_id", resendId)
    .maybeSingle();
  if (!send) return NextResponse.json({ ok: true, unmatched: true });

  await supabase.from("email_events").insert({
    send_id: send.id,
    lead_id: send.lead_id,
    event_type: mapped,
    event_data: (event.data || {}) as never,
  });

  if (mapped === "opened" && !send.opened_at) {
    await supabase.from("email_sends").update({ opened_at: new Date().toISOString() }).eq("id", send.id);
    await logActivity(supabase, {
      lead_id: send.lead_id,
      activity_type: "email_opened",
      title: `Opened: ${send.subject}`,
      data: { send_id: send.id },
    });
  }
  if (mapped === "clicked" && !send.clicked_at) {
    await supabase.from("email_sends").update({ clicked_at: new Date().toISOString() }).eq("id", send.id);
    await logActivity(supabase, {
      lead_id: send.lead_id,
      activity_type: "email_clicked",
      title: `Clicked: ${send.subject}`,
      data: { send_id: send.id, link: event.data?.click?.link },
    });
  }
  if (mapped === "bounced") {
    await supabase.from("email_sends").update({ status: "bounced" }).eq("id", send.id);
    await supabase.from("leads").update({ email_status: "bounced" }).eq("id", send.lead_id);
    await logActivity(supabase, {
      lead_id: send.lead_id,
      activity_type: "email_bounced",
      title: `Bounced: ${send.subject}`,
      data: { send_id: send.id },
    });
  }
  if (mapped === "complained") {
    await supabase.from("leads").update({ email_status: "complained" }).eq("id", send.lead_id);
    await logActivity(supabase, {
      lead_id: send.lead_id,
      activity_type: "unsubscribed",
      title: "Marked as spam (complaint) — suppressed",
      data: { send_id: send.id },
    });
  }

  return NextResponse.json({ ok: true });
}
