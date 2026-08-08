import { renderMergeTags, unsubscribeUrl } from "./merge";
import { renderEmailHtml } from "./markdown";
import { logActivity } from "./activity";
import { getCrmSettings } from "./settings";
import type { AdminClient, CrmSettings, Lead } from "./types";

export interface SendEmailInput {
  lead: Lead;
  subject: string;
  bodyMd: string;
  preheader?: string | null;
  templateId?: string | null;
  workflowId?: string | null;
  enrollmentId?: string | null;
  stepNumber?: number | null;
  actor?: string;
  /** A/B subject variant used for this send (only set while a test is live) */
  variant?: "a" | "b" | null;
}

export interface SendEmailResult {
  status: "sent" | "simulated" | "suppressed" | "failed";
  sendId?: string;
  error?: string;
}

/**
 * Sends one CRM email to a lead (or simulates it in safe mode), records it in
 * email_sends and on the lead timeline, and honours unsubscribes/bounces.
 */
export async function sendCrmEmail(
  supabase: AdminClient,
  input: SendEmailInput,
  settings?: CrmSettings
): Promise<SendEmailResult> {
  const cfg = settings ?? (await getCrmSettings(supabase));
  const lead = input.lead;

  const baseRow = {
    lead_id: lead.id,
    email_address: lead.email,
    subject: input.subject,
    step_number: input.stepNumber ?? null,
    workflow_id: input.workflowId ?? null,
    enrollment_id: input.enrollmentId ?? null,
    email_template_id: input.templateId ?? null,
    // Only reference the column when a test set it (inert until migration 018)
    ...(input.variant ? { variant: input.variant } : {}),
  };

  // Suppression: never email anyone who isn't subscribed, or who carries a
  // suppression tag. The tag check matters because tagging is how a list gets
  // retired by hand — before 2026-07-27 only email_status was consulted, so a
  // list tagged `suppressed-dead-list` kept sending and kept hard-bouncing
  // until the bounces tripped the breaker and froze every workflow.
  const suppressTag = (lead.tags || []).find((t) => (cfg.send_budget.suppress_tags || []).includes(t));
  if (lead.email_status !== "subscribed" || suppressTag) {
    const reason = suppressTag ? `suppressed by tag "${suppressTag}"` : `email_status is ${lead.email_status}`;
    await supabase.from("email_sends").insert({
      ...baseRow,
      status: "suppressed",
      error_message: reason,
    });
    return { status: "suppressed" };
  }

  const subject = renderMergeTags(input.subject, lead);
  const bodyMd = renderMergeTags(input.bodyMd, lead);
  const unsub = unsubscribeUrl(lead);
  const html = renderEmailHtml({
    bodyMd,
    preheader: input.preheader ? renderMergeTags(input.preheader, lead) : null,
    sender: cfg.sender,
    unsubscribeUrl: unsub,
  });

  const apiKey = process.env.RESEND_API_KEY;
  const safeMode = cfg.safe_mode || !apiKey;

  if (safeMode) {
    const { data } = await supabase
      .from("email_sends")
      .insert({ ...baseRow, subject, status: "simulated", body_html: html, sent_at: new Date().toISOString() })
      .select("id")
      .single();
    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "email_sent",
      title: `Simulated (safe mode): ${subject}`,
      data: { send_id: data?.id, workflow_id: input.workflowId, simulated: true },
      actor: input.actor ?? "system",
    });
    return { status: "simulated", sendId: data?.id };
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `${cfg.sender.from_name} <${cfg.sender.from_email}>`,
        to: [lead.email],
        subject,
        html,
        reply_to: cfg.sender.reply_to || cfg.sender.from_email,
        headers: {
          "List-Unsubscribe": `<${unsub}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    });

    const payload = (await res.json().catch(() => ({}))) as { id?: string; message?: string };

    if (!res.ok) {
      const errMsg = payload.message || `Resend responded ${res.status}`;
      await supabase
        .from("email_sends")
        .insert({ ...baseRow, subject, status: "failed", body_html: html, error_message: errMsg });
      return { status: "failed", error: errMsg };
    }

    const { data } = await supabase
      .from("email_sends")
      .insert({
        ...baseRow,
        subject,
        status: "sent",
        body_html: html,
        resend_id: payload.id ?? null,
        sent_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "email_sent",
      title: `Email sent: ${subject}`,
      data: { send_id: data?.id, resend_id: payload.id, workflow_id: input.workflowId },
      actor: input.actor ?? "system",
    });
    return { status: "sent", sendId: data?.id };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : "Unknown send error";
    await supabase
      .from("email_sends")
      .insert({ ...baseRow, subject, status: "failed", body_html: html, error_message: errMsg });
    return { status: "failed", error: errMsg };
  }
}

/**
 * Notification to the OWNER (not a lead) — hot-lead alerts, system heads-ups.
 * Ignores safe mode on purpose: these only ever go to the owner's own inbox.
 * Never throws; alerting must not break the caller.
 */
export async function notifyOwner(
  supabase: AdminClient,
  subject: string,
  bodyMd: string
): Promise<{ sent: boolean; error?: string }> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return { sent: false, error: "RESEND_API_KEY not configured" };
    const cfg = await getCrmSettings(supabase);
    const owner = cfg.sender.reply_to || cfg.sender.from_email;
    const html = renderEmailHtml({
      bodyMd,
      preheader: null,
      sender: cfg.sender,
      unsubscribeUrl: "",
    });
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${cfg.sender.from_name} <${cfg.sender.from_email}>`,
        to: [owner],
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => ({}))) as { message?: string };
      return { sent: false, error: payload.message || `Resend responded ${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : "notify failed" };
  }
}

/** Direct send for template tests — does not touch a lead record. */
export async function sendTestEmail(
  supabase: AdminClient,
  to: string,
  subject: string,
  html: string
): Promise<{ sent: boolean; error?: string; preview?: boolean }> {
  const apiKey = process.env.RESEND_API_KEY;
  const cfg = await getCrmSettings(supabase);
  if (!apiKey) {
    return { sent: false, preview: true, error: "RESEND_API_KEY not configured — returning preview only" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${cfg.sender.from_name} <${cfg.sender.from_email}>`,
      to: [to],
      subject: `[TEST] ${subject}`,
      html,
      reply_to: cfg.sender.reply_to || cfg.sender.from_email,
    }),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { message?: string };
    return { sent: false, error: payload.message || `Resend responded ${res.status}` };
  }
  return { sent: true };
}
