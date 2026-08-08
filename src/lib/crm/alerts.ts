/**
 * Hot-lead alerts: when a score rises through HOT_THRESHOLD the tick emails
 * the owner directly. Deduped to one alert per lead per 30 days so a bouncing
 * score can't spam the inbox.
 */
import { notifyOwner } from "./email";
import { logActivity } from "./activity";
import { HOT_THRESHOLD, type HotCrossing } from "./scoring";
import type { AdminClient } from "./types";

const DEDUPE_DAYS = 30;
const ALERT_TITLE_PREFIX = "Hot-lead alert fired";

export async function alertHotLeads(
  supabase: AdminClient,
  crossings: HotCrossing[]
): Promise<number> {
  let alerted = 0;
  for (const crossing of crossings) {
    const { data: lead } = await supabase
      .from("leads")
      .select("id, email, first_name, last_name, score, source, tags")
      .eq("id", crossing.lead_id)
      .single();
    if (!lead) continue;

    // Dedupe on the activity trail: the alert logs a note when it fires, so a
    // recent note means this lead already got its alert this window.
    const { data: recent } = await supabase
      .from("lead_activities")
      .select("id")
      .eq("lead_id", lead.id)
      .eq("activity_type", "note")
      .like("title", `${ALERT_TITLE_PREFIX}%`)
      .gte("created_at", new Date(Date.now() - DEDUPE_DAYS * 86_400_000).toISOString())
      .limit(1);
    if (recent?.length) continue;

    const name = [lead.first_name, lead.last_name].filter(Boolean).join(" ") || lead.email;

    await logActivity(supabase, {
      lead_id: lead.id,
      activity_type: "note",
      title: `${ALERT_TITLE_PREFIX} (score ${crossing.previous} → ${crossing.score})`,
      actor: "system",
    });

    await notifyOwner(
      supabase,
      `🔥 Hot lead: ${name} (score ${crossing.score})`,
      `**${name}** (${lead.email}) just crossed the hot-lead threshold: score **${crossing.previous} → ${crossing.score}**.\n\n` +
        `Source: ${lead.source || "unknown"} · Tags: ${(lead.tags || []).join(", ") || "none"}\n\n` +
        `Worth a personal follow-up while they're warm.`
    );
    alerted++;
  }
  return alerted;
}
