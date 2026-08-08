/**
 * POST /api/crm/templates/[id]/test — { to } send a test email (works even in
 * safe mode; requires RESEND_API_KEY, otherwise returns the rendered preview).
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { renderEmailHtml } from "@/lib/crm/markdown";
import { previewLead, renderMergeTags } from "@/lib/crm/merge";
import { getCrmSettings } from "@/lib/crm/settings";
import { sendTestEmail } from "@/lib/crm/email";
import { isValidEmail } from "@/lib/crm/leads";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!isValidEmail(to)) return NextResponse.json({ error: "Valid 'to' email is required" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: template } = await supabase.from("email_templates").select("*").eq("id", id).maybeSingle();
  if (!template) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const settings = await getCrmSettings(supabase);
  // Real merge engine over a sample lead, so test sends match live sends.
  // Unknown tags stay visible so typos are catchable in the test email.
  const sample = previewLead();
  const overrides = { email: to, unsubscribe_url: "#test-email" };
  const keep = { keepUnknownTags: true };
  const sampleMd = renderMergeTags(template.body_md, sample, overrides, keep);
  const html = renderEmailHtml({
    bodyMd: sampleMd,
    preheader: template.preheader ? renderMergeTags(template.preheader, sample, overrides, keep) : template.preheader,
    sender: settings.sender,
    unsubscribeUrl: "#test-email",
  });

  const result = await sendTestEmail(
    supabase,
    to,
    renderMergeTags(template.subject, sample, overrides, keep),
    html
  );
  if (!result.sent && !result.preview) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  return NextResponse.json({ sent: result.sent, preview_only: !!result.preview, note: result.error });
}
