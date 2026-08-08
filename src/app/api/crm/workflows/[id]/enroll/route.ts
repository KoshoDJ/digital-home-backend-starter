/**
 * POST /api/crm/workflows/[id]/enroll — bulk enrollment
 * Body: { lead_ids: string[] } or { filter: { tag?, status? } }
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { enrollLead } from "@/lib/crm/engine";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const supabase = createAdminClient();

  const { data: workflow } = await supabase.from("workflows").select("*").eq("id", id).maybeSingle();
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  if (workflow.status !== "active") {
    return NextResponse.json({ error: `Workflow is ${workflow.status} — activate it first` }, { status: 400 });
  }

  let leads: { id: string }[] = [];
  if (Array.isArray(body.lead_ids) && body.lead_ids.length > 0) {
    const { data } = await supabase.from("leads").select("*").in("id", body.lead_ids.slice(0, 500));
    leads = data || [];
  } else if (body.filter && typeof body.filter === "object") {
    let query = supabase.from("leads").select("*").limit(500);
    if (body.filter.tag) query = query.contains("tags", [body.filter.tag]);
    if (body.filter.status) query = query.eq("status", body.filter.status);
    if (body.filter.email_status) query = query.eq("email_status", body.filter.email_status);
    const { data } = await query;
    leads = data || [];
  } else {
    return NextResponse.json({ error: "lead_ids or filter is required" }, { status: 400 });
  }

  const source = auth.mode === "session" ? "bulk-manual" : `agent:${auth.agent}`;
  let enrolled = 0;
  let skipped = 0;
  for (const lead of leads) {
    const result = await enrollLead(supabase, workflow, lead as never, source);
    if (result.enrolled) enrolled++;
    else skipped++;
  }

  return NextResponse.json({ enrolled, skipped, total: leads.length });
}
