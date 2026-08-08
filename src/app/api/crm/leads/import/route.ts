/**
 * POST /api/crm/leads/import — bulk import (e.g. a GHL contact export).
 * Body: { rows: [{ email, first_name?, last_name?, name?, phone?, company?,
 *                  tags?: string[]|string, custom?: {} }], tag?, source?,
 *         fire_triggers? (default FALSE — imported contacts should not get
 *         welcome sequences) }
 * Caps at 500 rows per call; call repeatedly for larger imports.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { isValidEmail, upsertLead } from "@/lib/crm/leads";

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const body = await request.json().catch(() => ({}));
  const rows: Record<string, unknown>[] = Array.isArray(body.rows) ? body.rows : [];

  if (rows.length === 0) return NextResponse.json({ error: "rows array is required" }, { status: 400 });
  if (rows.length > 500) return NextResponse.json({ error: "Max 500 rows per call" }, { status: 400 });

  const fireTriggers = body.fire_triggers === true;
  const extraTag = typeof body.tag === "string" && body.tag.trim() ? body.tag.trim() : null;
  const source = typeof body.source === "string" ? body.source : "import";
  const actor = auth.mode === "session" ? "human" : `agent:${auth.agent}`;

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const email = typeof row.email === "string" ? row.email : "";
    if (!isValidEmail(email)) {
      skipped++;
      continue;
    }
    const rowTags = Array.isArray(row.tags)
      ? (row.tags as string[])
      : typeof row.tags === "string"
        ? row.tags.split(",").map((t) => t.trim())
        : [];
    try {
      const result = await upsertLead(
        supabase,
        {
          email,
          name: row.name as string | undefined,
          first_name: row.first_name as string | undefined,
          last_name: row.last_name as string | undefined,
          phone: (row.phone as string | undefined) ?? null,
          company: (row.company as string | undefined) ?? null,
          source,
          tags: extraTag ? [...rowTags, extraTag] : rowTags,
          custom: row.custom && typeof row.custom === "object" ? (row.custom as Record<string, unknown>) : {},
        },
        { actor, fireTriggers }
      );
      if (result.created) created++;
      else updated++;
    } catch (e) {
      errors.push(`${email}: ${e instanceof Error ? e.message : "failed"}`);
    }
  }

  return NextResponse.json({ created, updated, skipped, errors: errors.slice(0, 20), total: rows.length });
}
