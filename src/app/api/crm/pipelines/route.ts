/**
 * GET  /api/crm/pipelines — pipelines with their stages
 * POST /api/crm/pipelines — { name } create pipeline
 * PATCH /api/crm/pipelines — { id, name } rename
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const [{ data: pipelines, error }, { data: stages }] = await Promise.all([
    supabase.from("pipelines").select("*").order("position"),
    supabase.from("pipeline_stages").select("*").order("position"),
  ]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    pipelines: (pipelines || []).map((p) => ({
      ...p,
      stages: (stages || []).filter((s) => s.pipeline_id === p.id),
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
  const { data, error } = await supabase.from("pipelines").insert({ name }).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pipeline: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  if (!body.id || !body.name) return NextResponse.json({ error: "id and name are required" }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("pipelines")
    .update({ name: String(body.name).trim() })
    .eq("id", body.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ pipeline: data });
}
