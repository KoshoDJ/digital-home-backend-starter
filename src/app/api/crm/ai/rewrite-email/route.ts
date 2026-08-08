/**
 * POST /api/crm/ai/rewrite-email — revise one email with an instruction.
 * Body: { template_id? , subject?, body_md?, preheader?, instruction, apply? }
 * With template_id + apply !== false, the template is updated in place.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { callModelStructured, loadBrandContext, REWRITE_SCHEMA, SEQUENCE_CRAFT_RULES } from "@/lib/crm/ai";
import type { Json } from "@/types/database";

interface Rewrite {
  subject: string;
  preheader: string;
  body_md: string;
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = await request.json().catch(() => ({}));
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
  if (!instruction) return NextResponse.json({ error: "instruction is required" }, { status: 400 });

  const supabase = createAdminClient();

  let subject = body.subject as string | undefined;
  let preheader = body.preheader as string | undefined;
  let bodyMd = body.body_md as string | undefined;

  if (body.template_id) {
    const { data: tpl } = await supabase
      .from("email_templates")
      .select("*")
      .eq("id", body.template_id)
      .maybeSingle();
    if (!tpl) return NextResponse.json({ error: "Template not found" }, { status: 404 });
    subject = subject ?? tpl.subject;
    preheader = preheader ?? tpl.preheader ?? "";
    bodyMd = bodyMd ?? tpl.body_md;
  }

  if (!subject || !bodyMd) {
    return NextResponse.json({ error: "Provide template_id or subject + body_md" }, { status: 400 });
  }

  const brandContext = await loadBrandContext(supabase);
  const system = `You revise a single nurture email for the brand, keeping the brand voice intact.
${SEQUENCE_CRAFT_RULES}
Deliver the revised email with the deliver_result tool.`;

  const user = `## Brand brain
${brandContext}

## Current email
Subject: ${subject}
Preheader: ${preheader || "(none)"}
Body (markdown):
${bodyMd}

## Revision instruction
${instruction}

Rewrite the email accordingly and deliver it with the tool.`;

  try {
    const { result: rewrite, tokens } = await callModelStructured<Rewrite>(
      system,
      user,
      REWRITE_SCHEMA as unknown as Record<string, unknown>,
      4096
    );
    if (!rewrite.subject || !rewrite.body_md) {
      return NextResponse.json({ error: "AI returned an incomplete rewrite" }, { status: 502 });
    }

    let applied = false;
    if (body.template_id && body.apply !== false) {
      const { error } = await supabase
        .from("email_templates")
        .update({
          subject: rewrite.subject,
          preheader: rewrite.preheader || null,
          body_md: rewrite.body_md,
        })
        .eq("id", body.template_id);
      applied = !error;
    }

    await supabase.from("agent_logs").insert({
      agent: "email_agent",
      action: "rewrite_email",
      description: `Rewrote email${body.template_id ? ` (template ${body.template_id})` : ""}`,
      status: "completed",
      input_data: { instruction } as Json,
      tokens_used: tokens,
    });

    return NextResponse.json({ rewrite, applied, tokens });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "rewrite failed" }, { status: 500 });
  }
}
