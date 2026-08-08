/**
 * Custom field definitions for leads.custom
 * GET / POST { key, label, field_type?, options? } / PATCH { id, ... } / DELETE ?id=
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

const FIELD_TYPES = ["text", "number", "date", "select", "multiselect", "boolean", "url"];

export async function GET(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const { data, error } = await supabase.from("crm_custom_fields").select("*").order("sort_order");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ fields: data || [] });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim() : "";
  let key = typeof body.key === "string" ? body.key.trim() : "";
  if (!key && label) key = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!key || !label) return NextResponse.json({ error: "key and label are required" }, { status: 400 });

  const fieldType = FIELD_TYPES.includes(body.field_type) ? body.field_type : "text";

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("crm_custom_fields")
    .insert({
      key,
      label,
      field_type: fieldType,
      options: Array.isArray(body.options) ? body.options : [],
      sort_order: Number(body.sort_order) || 0,
    })
    .select("*")
    .single();
  if (error) {
    const status = error.code === "23505" ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ field: data }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const updates: Record<string, unknown> = {};
  if (body.label) updates.label = String(body.label).trim();
  if (body.field_type && FIELD_TYPES.includes(body.field_type)) updates.field_type = body.field_type;
  if (Array.isArray(body.options)) updates.options = body.options;
  if ("sort_order" in body) updates.sort_order = Number(body.sort_order) || 0;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("crm_custom_fields")
    .update(updates)
    .eq("id", body.id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ field: data });
}

export async function DELETE(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { error } = await supabase.from("crm_custom_fields").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
