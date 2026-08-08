/** POST /api/crm/leads/[id]/enroll — { workflow_id } enroll this lead */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { enrollLead } from "@/lib/crm/engine";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!body.workflow_id) return NextResponse.json({ error: "workflow_id is required" }, { status: 400 });

  const supabase = createAdminClient();
  const [{ data: lead }, { data: workflow }] = await Promise.all([
    supabase.from("leads").select("*").eq("id", id).maybeSingle(),
    supabase.from("workflows").select("*").eq("id", body.workflow_id).maybeSingle(),
  ]);
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  if (workflow.status !== "active") {
    return NextResponse.json({ error: `Workflow is ${workflow.status} — activate it first` }, { status: 400 });
  }

  const source = auth.mode === "session" ? "manual" : `agent:${auth.agent}`;
  const result = await enrollLead(supabase, workflow, lead, source);
  if (!result.enrolled) {
    return NextResponse.json({ enrolled: false, reason: result.reason }, { status: 409 });
  }
  return NextResponse.json({ enrolled: true }, { status: 201 });
}
