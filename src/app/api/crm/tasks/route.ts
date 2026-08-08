/**
 * GET  /api/crm/tasks?status=open — list tasks (joined lead)
 * POST /api/crm/tasks — { title, lead_id?, description?, due_at? }
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const status = request.nextUrl.searchParams.get("status");

  let query = supabase
    .from("crm_tasks")
    .select("*, leads(id, email, first_name, last_name)")
    .order("due_at", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (status === "open" || status === "done") query = query.eq("status", status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tasks: data || [] });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("crm_tasks")
    .insert({
      title,
      lead_id: body.lead_id || null,
      description: body.description || null,
      due_at: body.due_at || null,
      created_by: auth.mode === "session" ? "human" : `agent:${auth.agent}`,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data }, { status: 201 });
}
