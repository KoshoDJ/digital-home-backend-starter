/**
 * GET  /api/crm/workflows — list with enrollment stats
 * POST /api/crm/workflows — create (defaults to draft)
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { parseSteps } from "@/lib/crm/types";
import type { Json } from "@/types/database";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const includeArchived = request.nextUrl.searchParams.get("archived") === "true";

  let query = supabase.from("workflows").select("*").order("updated_at", { ascending: false });
  if (!includeArchived) query = query.neq("status", "archived");

  const { data: workflows, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const ids = (workflows || []).map((w) => w.id);
  const activeCounts = new Map<string, number>();
  const emailStats = new Map<string, { sent: number; opened: number; clicked: number }>();
  if (ids.length) {
    const { data: enrollments } = await supabase
      .from("workflow_enrollments")
      .select("workflow_id")
      .eq("status", "active")
      .in("workflow_id", ids);
    for (const e of enrollments || []) {
      activeCounts.set(e.workflow_id, (activeCounts.get(e.workflow_id) || 0) + 1);
    }

    // Engagement rollup — real deliveries only (simulated/suppressed/failed
    // sends would distort the rates).
    const { data: sends } = await supabase
      .from("email_sends")
      .select("workflow_id, opened_at, clicked_at")
      .in("workflow_id", ids)
      .eq("status", "sent")
      .order("created_at", { ascending: false })
      .limit(10000);
    for (const s of sends || []) {
      if (!s.workflow_id) continue;
      const stat = emailStats.get(s.workflow_id) || { sent: 0, opened: 0, clicked: 0 };
      stat.sent++;
      if (s.opened_at) stat.opened++;
      if (s.clicked_at) stat.clicked++;
      emailStats.set(s.workflow_id, stat);
    }
  }

  return NextResponse.json({
    workflows: (workflows || []).map((w) => ({
      ...w,
      step_count: parseSteps(w.steps).length,
      active_enrollments: activeCounts.get(w.id) || 0,
      email_stats: emailStats.get(w.id) || { sent: 0, opened: 0, clicked: 0 },
    })),
  });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("workflows")
    .insert({
      name,
      description: body.description || null,
      trigger_type: body.trigger_type || "manual",
      trigger_config: (body.trigger_config || {}) as Json,
      steps: (Array.isArray(body.steps) ? body.steps : []) as Json,
      allow_reenrollment: body.allow_reenrollment === true,
      status: "draft",
      ai_brief: (body.ai_brief || null) as Json,
    })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workflow: data }, { status: 201 });
}
