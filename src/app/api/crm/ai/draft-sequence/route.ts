/**
 * POST /api/crm/ai/draft-sequence — the AI nurture composer.
 *
 * You brief it like you'd brief a copywriter; it drafts the whole sequence in
 * the brand voice (grounded in brand_context + real offers), creates the email
 * templates, and assembles a DRAFT workflow for human review. Nothing sends
 * until you activate the workflow.
 *
 * Body: {
 *   brief: string            — what this sequence is for, who it's talking to,
 *                              where it should lead ("nurture new newsletter
 *                              leads toward a discovery call over 2 weeks")
 *   num_emails?: number      — default 5, max 8
 *   offer_slug?: string      — anchor the CTA to a specific offer
 *   audience?: string        — extra audience context
 *   trigger_type?, trigger_config? — suggested trigger for the workflow
 *   create?: boolean         — default true; false returns the draft only
 * }
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  callModelStructured,
  loadBrandContext,
  loadOffers,
  repairJsonQuotes,
  SEQUENCE_CRAFT_RULES,
  SEQUENCE_SCHEMA,
  CRM_AI_MODEL,
} from "@/lib/crm/ai";
import type { Json } from "@/types/database";

interface DraftEmail {
  position: number;
  wait_before: { days: number; hours?: number };
  subject: string;
  preheader: string;
  body_md: string;
  purpose: string;
}

interface DraftSequence {
  name: string;
  description: string;
  goal: string;
  emails: DraftEmail[];
}

/**
 * Recover an emails array the model string-encoded instead of returning as a
 * real array. Direct parse first; on failure, the write-article repair
 * pipeline: control chars -> spaces (so formatting newlines don't confuse the
 * quote look-ahead), then escape unescaped interior quotes (quoted dialogue
 * in email copy is the classic breakage), then parse again.
 */
function parseEmailsString(raw: string): DraftEmail[] | null {
  const first = raw.indexOf("[");
  const last = raw.lastIndexOf("]");
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = raw.slice(first, last + 1);
  try {
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? (parsed as DraftEmail[]) : null;
  } catch {
    // repair pass below
  }
  const repaired = repairJsonQuotes(candidate.replace(/[\u0000-\u001F\u007F]/g, " "));
  try {
    const parsed = JSON.parse(repaired);
    return Array.isArray(parsed) ? (parsed as DraftEmail[]) : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const brief = typeof body.brief === "string" ? body.brief.trim() : "";
  if (brief.length < 10) {
    return NextResponse.json({ error: "brief is required (tell the AI what this sequence is for)" }, { status: 400 });
  }

  const numEmails = Math.min(8, Math.max(1, Number(body.num_emails) || 5));
  const supabase = createAdminClient();
  const startedAt = Date.now();

  const [brandContext, offers] = await Promise.all([loadBrandContext(supabase), loadOffers(supabase)]);

  const system = `You are the brand's in-house lifecycle marketer. You write email nurture sequences that sound exactly like the brand — never like a template. You are given the brand brain (voice, positioning, pillars, audience) and the live offer list. You follow direct-response best practice without ever sounding like direct response.
${SEQUENCE_CRAFT_RULES}
Deliver the sequence with the deliver_result tool. "wait_before" is the delay BEFORE that email, relative to the previous one (first email usually 0 days).`;

  const user = `## Brand brain
${brandContext}

## Live offers
${offers}

## Brief from the strategist
${brief}
${body.audience ? `\n## Audience notes\n${body.audience}` : ""}
${body.offer_slug ? `\nAnchor the sequence CTA to the offer with slug "${body.offer_slug}".` : ""}

Write a ${numEmails}-email nurture sequence and deliver it with the tool.`;

  try {
    // A full email is ~800-1,200 output tokens as JSON; the old 8k default
    // silently truncated anything past ~4 emails. Scale with the ask.
    const maxTokens = Math.min(32000, 6000 + numEmails * 4000);
    const { result: rawDraft, tokens } = await callModelStructured<DraftSequence>(
      system,
      user,
      SEQUENCE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens
    );

    // Even under forced tool use the model occasionally returns the nested
    // `emails` array double-encoded as a JSON string (long copy triggers it).
    // A string has .length, so it slips past a truthiness check and then
    // breaks iteration — normalize to a real array before touching it.
    let emails: DraftEmail[] = [];
    const rawEmails: unknown = (rawDraft as { emails?: unknown }).emails;
    if (Array.isArray(rawEmails)) {
      emails = rawEmails as DraftEmail[];
    } else if (typeof rawEmails === "string") {
      emails = parseEmailsString(rawEmails) ?? [];
      console.warn(
        `draft-sequence: emails arrived string-encoded (${rawEmails.length} chars); recovered ${emails.length} emails`
      );
    }
    emails = emails.filter((e) => e && typeof e.subject === "string" && typeof e.body_md === "string");

    if (!emails.length) {
      return NextResponse.json({ error: "AI returned no usable emails — try rephrasing the brief" }, { status: 502 });
    }
    const draft: DraftSequence = { ...rawDraft, emails };

    // Return-only mode for agents that want to post-process
    if (body.create === false) {
      return NextResponse.json({ draft, model: CRM_AI_MODEL, tokens });
    }

    // Create templates + draft workflow
    const steps: { id: string; type: string; config: Record<string, unknown> }[] = [];
    const templateIds: string[] = [];

    for (const [i, email] of draft.emails.entries()) {
      const { data: tpl, error } = await supabase
        .from("email_templates")
        .insert({
          name: `${draft.name} — Email ${i + 1}`,
          subject: email.subject,
          preheader: email.preheader || null,
          body_md: email.body_md,
          category: "sequence",
          ai_generated: true,
        })
        .select("id")
        .single();
      if (error || !tpl) throw new Error(`template insert failed: ${error?.message}`);
      templateIds.push(tpl.id);

      const days = Number(email.wait_before?.days) || 0;
      const hours = Number(email.wait_before?.hours) || 0;
      if (days > 0 || hours > 0) {
        steps.push({ id: `wait-${i + 1}`, type: "wait", config: { days, hours } });
      }
      steps.push({
        id: `email-${i + 1}`,
        type: "send_email",
        config: { template_id: tpl.id, note: email.purpose },
      });
    }

    const { data: workflow, error: wfError } = await supabase
      .from("workflows")
      .insert({
        name: draft.name,
        description: draft.description,
        status: "draft",
        trigger_type: body.trigger_type || "manual",
        trigger_config: (body.trigger_config || {}) as Json,
        steps: steps as Json,
        ai_brief: { brief, audience: body.audience, offer_slug: body.offer_slug, goal: draft.goal, model: CRM_AI_MODEL } as Json,
      })
      .select("*")
      .single();
    if (wfError || !workflow) throw new Error(`workflow insert failed: ${wfError?.message}`);

    await supabase.from("agent_logs").insert({
      agent: "email_agent",
      action: "draft_sequence",
      description: `Drafted "${draft.name}" (${draft.emails.length} emails) from brief`,
      status: "completed",
      target_table: "workflows",
      target_id: workflow.id,
      input_data: { brief, num_emails: numEmails } as Json,
      output_data: { workflow_id: workflow.id, template_ids: templateIds } as Json,
      duration_ms: Date.now() - startedAt,
      tokens_used: tokens,
    });

    return NextResponse.json({ workflow, draft, template_ids: templateIds, tokens }, { status: 201 });
  } catch (e) {
    const message = e instanceof Error ? e.message : "draft failed";
    await supabase.from("agent_logs").insert({
      agent: "email_agent",
      action: "draft_sequence",
      description: "Sequence draft failed",
      status: "failed",
      error_message: message,
      input_data: { brief } as Json,
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
