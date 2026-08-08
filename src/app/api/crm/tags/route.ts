/**
 * GET    /api/crm/tags — tag registry + usage counts
 * POST   /api/crm/tags — { name, color? }
 * PATCH  /api/crm/tags — { id, name?, color? }
 * DELETE /api/crm/tags?id= — remove from registry (does not strip from leads)
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const [{ data: registry }, { data: leadTags }] = await Promise.all([
    supabase.from("crm_tags").select("*").order("name"),
    supabase.from("leads").select("tags").not("tags", "eq", "{}"),
  ]);

  const counts = new Map<string, number>();
  for (const row of leadTags || []) {
    for (const t of row.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
  }

  const known = new Set((registry || []).map((r) => r.name));
  const unregistered = Array.from(counts.keys())
    .filter((t) => !known.has(t))
    .map((name) => ({ id: null, name, color: null, count: counts.get(name) || 0 }));

  return NextResponse.json({
    tags: [
      ...(registry || []).map((r) => ({ ...r, count: counts.get(r.name) || 0 })),
      ...unregistered,
    ].sort((a, b) => a.name.localeCompare(b.name)),
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
    .from("crm_tags")
    .upsert({ name, color: body.color || null }, { onConflict: "name" })
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tag: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (body.name) updates.name = String(body.name).trim();
  if ("color" in body) updates.color = body.color;

  const supabase = createAdminClient();
  const { data, error } = await supabase.from("crm_tags").update(updates).eq("id", body.id).select("*").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tag: data });
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { error } = await supabase.from("crm_tags").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
