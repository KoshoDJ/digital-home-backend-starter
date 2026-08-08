/**
 * POST /api/crm/webhooks/inbound — inbound email replies from a lead.
 * Point any inbound-parse service (Resend inbound, Zapier email parser,
 * CloudMailin, …) here with the x-capture-key header (crm_capture_key
 * setting), or call it signed like any machine endpoint.
 *
 * Body: { from: "Name <a@b.com>" | "a@b.com", subject?: string, text?: string }
 *
 * Records the reply on the lead's timeline (activity_type 'email_reply' — a
 * +20 scoring signal), bumps new leads to 'engaged', and leaves drafting the
 * response to a human or agent.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { authenticateCapture } from "@/lib/crm/capture-auth";
import { logActivity } from "@/lib/crm/activity";

function extractEmail(raw: string): string {
  const angled = raw.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : raw).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : "";
}

export async function POST(request: NextRequest) {
  const supabase = createAdminClient();
  const auth = await authenticateCapture(request, supabase);
  if (!auth.ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await request.json().catch(() => null)) as {
    from?: string;
    subject?: string;
    text?: string;
  } | null;
  const email = extractEmail(String(body?.from || ""));
  if (!email) return NextResponse.json({ error: "from is required" }, { status: 400 });

  const { data: lead } = await supabase.from("leads").select("id, status").eq("email", email).maybeSingle();
  if (!lead) return NextResponse.json({ ok: true, unmatched: true, email });

  const subject = String(body?.subject || "").slice(0, 200);
  const text = String(body?.text || "").slice(0, 8000);

  await logActivity(supabase, {
    lead_id: lead.id,
    activity_type: "email_reply",
    title: subject ? `Reply: ${subject}` : "Reply received",
    body: text || null,
    actor: "lead",
  });

  if (lead.status === "new") {
    await supabase.from("leads").update({ status: "engaged" }).eq("id", lead.id);
  }

  return NextResponse.json({ ok: true, lead_id: lead.id });
}
