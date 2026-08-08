/**
 * POST   /api/crm/pipelines/stages — { pipeline_id, name, position? }
 * PATCH  /api/crm/pipelines/stages — { id, name?, position? }
 * DELETE /api/crm/pipelines/stages?id= (fails if opportunities sit in it)
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  if (!body.pipeline_id || !body.name) {
    return NextResponse.json({ error: "pipeline_id and name are required" }, { status: 400 });
  }

  const supabase = createAdminClient();

  let position = Number(body.position);
  if (!Number.isFinite(position)) {
    const { data: last } = await supabase
      .from("pipeline_stages")
      .select("position")
      .eq("pipeline_id", body.pipeline_id)
      .order("position", { ascending: false })
      .limit(1);
    position = last && last.length ? last[0].position + 1 : 0;
  }

  const { data, error } = await supabase
    .from("pipeline_stages")
    .insert({ pipeline_id: body.pipeline_id, name: String(body.name).trim(), position })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ stage: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (body.name) updates.name = String(body.name).trim();
  if ("position" in body) updates.position = Number(body.position) || 0;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("pipeline_stages")
    .update(updates)
    .eq("id", body.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ stage: data });
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { count } = await supabase
    .from("opportunities")
    .select("id", { count: "exact", head: true })
    .eq("stage_id", id);
  if ((count || 0) > 0) {
    return NextResponse.json(
      { error: `Stage has ${count} opportunities — move them first` },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("pipeline_stages").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
