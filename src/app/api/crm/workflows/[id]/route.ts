/**
 * GET    /api/crm/workflows/[id] — workflow + enrollment breakdown
 * PATCH  /api/crm/workflows/[id] — update steps/trigger/status/name
 * DELETE /api/crm/workflows/[id] — archive + exit active enrollments
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { parseSteps, WORKFLOW_STEP_TYPES } from "@/lib/crm/types";
import type { WorkflowStep } from "@/lib/crm/types";
import type { Json } from "@/types/database";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();

  const { data: workflow, error } = await supabase.from("workflows").select("*").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const { data: enrollments } = await supabase
    .from("workflow_enrollments")
    .select("*, leads(id, email, first_name, last_name)")
    .eq("workflow_id", id)
    .order("enrolled_at", { ascending: false })
    .limit(50);

  const counts: Record<string, number> = { active: 0, completed: 0, exited: 0, failed: 0 };
  const { data: allEnrollments } = await supabase
    .from("workflow_enrollments")
    .select("status")
    .eq("workflow_id", id);
  for (const e of allEnrollments || []) counts[e.status] = (counts[e.status] || 0) + 1;

  // Engagement per email step (real deliveries only) — step_number on a send
  // is the step's index in the workflow at send time.
  const emailStats = { sent: 0, opened: 0, clicked: 0 };
  const byStep: Record<number, { sent: number; opened: number; clicked: number }> = {};
  const { data: sends } = await supabase
    .from("email_sends")
    .select("step_number, opened_at, clicked_at")
    .eq("workflow_id", id)
    .eq("status", "sent")
    .order("created_at", { ascending: false })
    .limit(10000);
  for (const s of sends || []) {
    emailStats.sent++;
    if (s.opened_at) emailStats.opened++;
    if (s.clicked_at) emailStats.clicked++;
    if (s.step_number != null) {
      const step = (byStep[s.step_number] ||= { sent: 0, opened: 0, clicked: 0 });
      step.sent++;
      if (s.opened_at) step.opened++;
      if (s.clicked_at) step.clicked++;
    }
  }

  return NextResponse.json({
    workflow,
    enrollments: enrollments || [],
    enrollment_counts: counts,
    email_stats: { ...emailStats, by_step: byStep },
  });
}

function validateSteps(steps: WorkflowStep[]): string | null {
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!WORKFLOW_STEP_TYPES.includes(s.type)) return `Step ${i + 1}: unknown type "${s.type}"`;
    const cfg = s.config || {};
    if (s.type === "send_email" && !cfg.template_id && !(cfg.subject && cfg.body_md)) {
      return `Step ${i + 1}: send_email needs a template_id or inline subject + body_md`;
    }
    if (s.type === "wait" && !Number(cfg.days) && !Number(cfg.hours) && !Number(cfg.minutes)) {
      return `Step ${i + 1}: wait needs days, hours or minutes`;
    }
    if ((s.type === "add_tag" || s.type === "remove_tag") && !cfg.tag) {
      return `Step ${i + 1}: ${s.type} needs a tag`;
    }
    if (s.type === "move_stage" && !cfg.stage_id) return `Step ${i + 1}: move_stage needs stage_id`;
    if (s.type === "set_status" && !cfg.status) return `Step ${i + 1}: set_status needs status`;
    if (s.type === "update_field" && !cfg.key) return `Step ${i + 1}: update_field needs key`;
    if (s.type === "webhook" && !/^https?:\/\//.test(String(cfg.url || ""))) {
      return `Step ${i + 1}: webhook needs a valid url`;
    }
    if (s.type === "create_task" && !cfg.title) return `Step ${i + 1}: create_task needs title`;
  }
  return null;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const supabase = createAdminClient();

  const { data: workflow } = await supabase.from("workflows").select("*").eq("id", id).maybeSingle();
  if (!workflow) return NextResponse.json({ error: "Workflow not found" }, { status: 404 });

  const updates: Record<string, unknown> = {};
  if (typeof body.name === "string" && body.name.trim()) updates.name = body.name.trim();
  if ("description" in body) updates.description = body.description || null;
  if (body.trigger_type) updates.trigger_type = body.trigger_type;
  if ("trigger_config" in body) updates.trigger_config = (body.trigger_config || {}) as Json;
  if ("allow_reenrollment" in body) updates.allow_reenrollment = body.allow_reenrollment === true;
  if ("ai_brief" in body) updates.ai_brief = (body.ai_brief || null) as Json;

  if ("steps" in body) {
    if (!Array.isArray(body.steps)) return NextResponse.json({ error: "steps must be an array" }, { status: 400 });
    updates.steps = body.steps as Json;
  }

  if (body.status && ["draft", "active", "paused", "archived"].includes(body.status)) {
    if (body.status === "active") {
      const steps = parseSteps("steps" in updates ? updates.steps : workflow.steps);
      if (steps.length === 0) {
        return NextResponse.json({ error: "Cannot activate a workflow with no steps" }, { status: 400 });
      }
      const problem = validateSteps(steps);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    }
    updates.status = body.status;
  } else if ("steps" in updates) {
    const problem = validateSteps(parseSteps(updates.steps));
    if (problem && workflow.status === "active") {
      return NextResponse.json({ error: problem }, { status: 400 });
    }
  }

  const { data: updated, error } = await supabase
    .from("workflows")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workflow: updated });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();

  await supabase
    .from("workflow_enrollments")
    .update({ status: "exited" })
    .eq("workflow_id", id)
    .eq("status", "active");

  const { error } = await supabase.from("workflows").update({ status: "archived" }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ archived: true });
}
