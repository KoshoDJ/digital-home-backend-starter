/** PATCH /api/crm/tasks/[id] — complete/reopen/edit; DELETE removes */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};

  if (body.status === "done") {
    updates.status = "done";
    updates.completed_at = new Date().toISOString();
  } else if (body.status === "open") {
    updates.status = "open";
    updates.completed_at = null;
  }
  if (typeof body.title === "string" && body.title.trim()) updates.title = body.title.trim();
  if ("description" in body) updates.description = body.description || null;
  if ("due_at" in body) updates.due_at = body.due_at || null;

  if (Object.keys(updates).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase.from("crm_tasks").update(updates).eq("id", id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ task: data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();
  const { error } = await supabase.from("crm_tasks").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
