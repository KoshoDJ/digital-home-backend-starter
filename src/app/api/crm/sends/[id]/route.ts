/**
 * GET /api/crm/sends/[id] — one email exactly as it went to the lead:
 * the post-merge-tag subject and stored body_html, plus delivery/open/click
 * state and which workflow step produced it. Fetched on demand so lead
 * pages don't drag full email bodies around.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await context.params;
  const supabase = createAdminClient();
  const { data: send, error } = await supabase
    .from("email_sends")
    .select(
      "id, lead_id, email_address, subject, body_html, status, step_number, variant, workflow_id, sent_at, opened_at, clicked_at, error_message, created_at"
    )
    .eq("id", id)
    .single();
  if (error || !send) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let workflowName: string | null = null;
  if (send.workflow_id) {
    const { data: wf } = await supabase
      .from("workflows")
      .select("name")
      .eq("id", send.workflow_id)
      .maybeSingle();
    workflowName = wf?.name || null;
  }

  return NextResponse.json({ send: { ...send, workflow_name: workflowName } });
}
