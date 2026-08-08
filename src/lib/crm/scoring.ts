/**
 * Lead scoring — simple additive signals, recomputed idempotently on every
 * engine tick so scores stay fresh without their own cron:
 *   quiz completed +30 · email open +5 (cap 5) · click +15 (cap 3)
 *   form submit +10 (cap 3) · linked site visit +5 (cap 4) · reply +20 (cap 2)
 *   recency decay: halved when no activity for 30 days.
 * Also reports hot-lead crossings (score rising through HOT_THRESHOLD) so the
 * tick can alert the owner.
 */
import type { AdminClient } from "./types";

const POINTS = {
  quiz: 30,
  open: 5,
  openCap: 5,
  click: 15,
  clickCap: 3,
  form: 10,
  formCap: 3,
  visit: 5,
  visitCap: 4,
  reply: 20,
  replyCap: 2,
} as const;

const DECAY_AFTER_MS = 30 * 86_400_000;

export const HOT_THRESHOLD = 50;

export interface HotCrossing {
  lead_id: string;
  previous: number;
  score: number;
}

export interface ScoreSummary {
  scanned: number;
  updated: number;
  hot_crossings: HotCrossing[];
}

function bump(map: Map<string, number>, key: string | null, by = 1): void {
  if (!key) return;
  map.set(key, (map.get(key) || 0) + by);
}

export async function recomputeLeadScores(supabase: AdminClient): Promise<ScoreSummary> {
  const { data: leads, error } = await supabase
    .from("leads")
    .select("id, score, custom, last_activity_at, created_at")
    .limit(5000);
  if (error || !leads?.length) return { scanned: 0, updated: 0, hot_crossings: [] };

  const [events, forms, visits, replies] = await Promise.all([
    supabase
      .from("email_events")
      .select("lead_id, event_type")
      .in("event_type", ["opened", "clicked"])
      .limit(10000),
    supabase
      .from("lead_activities")
      .select("lead_id")
      .eq("activity_type", "form_submitted")
      .limit(10000),
    supabase.from("visitors").select("lead_id, visit_count").not("lead_id", "is", null).limit(10000),
    supabase
      .from("lead_activities")
      .select("lead_id")
      .eq("activity_type", "email_reply")
      .limit(10000),
  ]);

  const opens = new Map<string, number>();
  const clicks = new Map<string, number>();
  for (const e of events.data || []) {
    bump(e.event_type === "opened" ? opens : clicks, e.lead_id);
  }
  const formCounts = new Map<string, number>();
  for (const f of forms.data || []) bump(formCounts, f.lead_id);
  const visitCounts = new Map<string, number>();
  for (const v of visits.data || []) bump(visitCounts, v.lead_id, Math.max(1, v.visit_count || 1));
  const replyCounts = new Map<string, number>();
  for (const r of replies.data || []) bump(replyCounts, r.lead_id);

  let updated = 0;
  const hotCrossings: HotCrossing[] = [];
  for (const lead of leads) {
    const custom = (lead.custom && typeof lead.custom === "object" ? lead.custom : {}) as Record<
      string,
      unknown
    >;
    let score = 0;
    if (typeof custom.quiz_summary === "string" && custom.quiz_summary) score += POINTS.quiz;
    score += Math.min(opens.get(lead.id) || 0, POINTS.openCap) * POINTS.open;
    score += Math.min(clicks.get(lead.id) || 0, POINTS.clickCap) * POINTS.click;
    score += Math.min(formCounts.get(lead.id) || 0, POINTS.formCap) * POINTS.form;
    score += Math.min(visitCounts.get(lead.id) || 0, POINTS.visitCap) * POINTS.visit;
    score += Math.min(replyCounts.get(lead.id) || 0, POINTS.replyCap) * POINTS.reply;

    const lastActivity = Date.parse(lead.last_activity_at || lead.created_at || "") || 0;
    if (Date.now() - lastActivity > DECAY_AFTER_MS) score = Math.floor(score / 2);

    if (score !== lead.score) {
      const { error: updateError } = await supabase
        .from("leads")
        .update({ score })
        .eq("id", lead.id);
      if (!updateError) {
        updated++;
        if (score >= HOT_THRESHOLD && (lead.score ?? 0) < HOT_THRESHOLD) {
          hotCrossings.push({ lead_id: lead.id, previous: lead.score ?? 0, score });
        }
      }
    }
  }

  return { scanned: leads.length, updated, hot_crossings: hotCrossings };
}
