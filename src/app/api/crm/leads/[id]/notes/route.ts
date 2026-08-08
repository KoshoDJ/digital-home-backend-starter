/** POST /api/crm/leads/[id]/notes — add a note to the lead timeline */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { logActivity } from "@/lib/crm/activity";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return NextResponse.json({ error: "body is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: lead } = await supabase.from("leads").select("id").eq("id", id).maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  await logActivity(supabase, {
    lead_id: id,
    activity_type: "note",
    title: body.title || "Note",
    body: text,
    actor: auth.mode === "session" ? "human" : `agent:${auth.agent}`,
  });

  return NextResponse.json({ ok: true }, { status: 201 });
}
