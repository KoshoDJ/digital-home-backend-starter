/**
 * A/B subject-line testing. A template with subject_b set is a live test: the
 * engine alternates subjects per send (variant recorded on email_sends), and
 * every tick this promoter checks results — once both variants have enough
 * REAL sends and a clear open-rate winner, it promotes the winner and ends
 * the test. Inert until migration 018 adds the columns (queries error, caller
 * catches).
 */
import type { AdminClient } from "./types";
import type { Json } from "@/types/database";

const MIN_SENDS_PER_VARIANT = 30;
const MIN_OPEN_RATE_GAP = 0.05; // 5 points absolute

export interface AbPromotionSummary {
  active_tests: number;
  promoted: string[];
}

export async function promoteSubjectTests(supabase: AdminClient): Promise<AbPromotionSummary> {
  const { data: templates, error } = await supabase
    .from("email_templates")
    .select("id, name, subject, subject_b")
    .not("subject_b", "is", null);
  if (error) throw new Error(error.message);
  if (!templates?.length) return { active_tests: 0, promoted: [] };

  const promoted: string[] = [];
  for (const tpl of templates) {
    // Only real deliveries count — simulated safe-mode sends have no opens
    const { data: sends } = await supabase
      .from("email_sends")
      .select("variant, opened_at")
      .eq("email_template_id", tpl.id)
      .eq("status", "sent")
      .not("variant", "is", null)
      .limit(5000);

    const stats = { a: { sends: 0, opens: 0 }, b: { sends: 0, opens: 0 } };
    for (const s of sends || []) {
      const v = s.variant === "b" ? "b" : "a";
      stats[v].sends++;
      if (s.opened_at) stats[v].opens++;
    }
    if (stats.a.sends < MIN_SENDS_PER_VARIANT || stats.b.sends < MIN_SENDS_PER_VARIANT) continue;

    const rateA = stats.a.opens / stats.a.sends;
    const rateB = stats.b.opens / stats.b.sends;
    if (Math.abs(rateA - rateB) < MIN_OPEN_RATE_GAP) continue;

    const winnerIsB = rateB > rateA;
    const { error: updateError } = await supabase
      .from("email_templates")
      .update(winnerIsB ? { subject: tpl.subject_b as string, subject_b: null } : { subject_b: null })
      .eq("id", tpl.id);
    if (updateError) continue;

    const line =
      `"${tpl.name}": variant ${winnerIsB ? "B" : "A"} promoted — ` +
      `${(rateB * 100).toFixed(0)}% vs ${(rateA * 100).toFixed(0)}% opens ` +
      `(B ${stats.b.opens}/${stats.b.sends}, A ${stats.a.opens}/${stats.a.sends})`;
    promoted.push(line);

    await supabase.from("agent_logs").insert({
      agent: "email_agent",
      action: "ab_promotion",
      description: line,
      status: "completed",
      output_data: { template_id: tpl.id, stats, winner: winnerIsB ? "b" : "a" } as unknown as Json,
    });
  }

  return { active_tests: templates.length, promoted };
}
