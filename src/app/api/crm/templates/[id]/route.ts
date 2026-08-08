/**
 * GET    /api/crm/templates/[id] — template + rendered HTML preview
 * PATCH  /api/crm/templates/[id]
 * DELETE /api/crm/templates/[id] (blocked while workflows reference it)
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { renderEmailHtml } from "@/lib/crm/markdown";
import { previewLead, renderMergeTags } from "@/lib/crm/merge";
import { getCrmSettings } from "@/lib/crm/settings";
import { parseSteps } from "@/lib/crm/types";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();
  const { data: template, error } = await supabase.from("email_templates").select("*").eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const settings = await getCrmSettings(supabase);
  const sample = previewLead();
  const keep = { keepUnknownTags: true }; // typo'd tags stay visible in previews
  const previewMd = renderMergeTags(template.body_md, sample, { unsubscribe_url: "#unsubscribe-preview" }, keep);
  const html = renderEmailHtml({
    bodyMd: previewMd,
    preheader: template.preheader ? renderMergeTags(template.preheader, sample, {}, keep) : template.preheader,
    sender: settings.sender,
    unsubscribeUrl: "#unsubscribe-preview",
  });

  return NextResponse.json({ template, preview_html: html });
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const updates: Record<string, unknown> = {};
  for (const f of ["name", "subject", "preheader", "body_md", "category"]) {
    if (f in body) updates[f] = body[f];
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 });

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("email_templates")
    .update(updates)
    .eq("id", id)
    .select("*")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ template: data });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const supabase = createAdminClient();

  // Refuse to delete templates still referenced by non-archived workflows
  const { data: workflows } = await supabase.from("workflows").select("id, name, steps").neq("status", "archived");
  const referencedBy = (workflows || []).filter((w) =>
    parseSteps(w.steps).some((s) => s.type === "send_email" && s.config?.template_id === id)
  );
  if (referencedBy.length > 0) {
    return NextResponse.json(
      { error: `Template is used by: ${referencedBy.map((w) => w.name).join(", ")}` },
      { status: 409 }
    );
  }

  const { error } = await supabase.from("email_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
