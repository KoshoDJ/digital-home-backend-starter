/**
 * Pipeline health alerts.
 *
 * Why this exists (2026-07-27): the send circuit breaker tripped on 22 July
 * and paused every workflow for five days. Nothing surfaced it. A breaker trip
 * writes to agent_logs and clears `last_error` on the enrollments it parks, so
 * every record looked healthy, every scheduled run reported success, and new
 * leads sat in silence until a weekly report happened to notice.
 *
 * The rule this encodes: a pipeline that stops sending must say so out loud.
 *
 * Detects, on every tick:
 *   1. breaker tripped         — sends paused by bounce/complaint rate
 *   2. failed sends            — the provider refused and nothing retried
 *   3. overdue enrollments     — steps due long ago that never ran
 *
 * Alerts are deduplicated: the same problem re-notifies at most once per
 * COOLDOWN_HOURS, but a NEW kind of problem always notifies immediately. When
 * everything clears, it sends one recovery note so silence is unambiguous —
 * you learn that it's fixed, not just that it stopped complaining.
 *
 * NOTE: this cannot detect the tick itself dying — it only runs when the tick
 * runs. That failure mode needs an outside watchdog (see the
 * crm-pipeline-watchdog scheduled task).
 */
import type { AdminClient, CrmSettings } from "./types";
import type { Json } from "@/types/database";
import { notifyOwner } from "./email";

const STATE_KEY = "crm_health_alert";
const COOLDOWN_HOURS = 6;
const OVERDUE_HOURS = 6;
const FAILED_LOOKBACK_HOURS = 3;

export interface HealthCheck {
  alerts: { key: string; line: string }[];
  notified: boolean;
  recovered: boolean;
}

interface AlertState {
  signature: string;
  last_alert_at: string;
}

export async function runHealthChecks(
  supabase: AdminClient,
  settings: CrmSettings,
  breakerTripped: { bounce_rate: number; complaint_rate: number; sends_24h: number } | null
): Promise<HealthCheck> {
  const alerts: { key: string; line: string }[] = [];
  const now = Date.now();

  if (breakerTripped) {
    alerts.push({
      key: "breaker",
      line:
        `**Sends are paused.** The circuit breaker tripped: ` +
        `${(breakerTripped.bounce_rate * 100).toFixed(1)}% bounces / ` +
        `${(breakerTripped.complaint_rate * 100).toFixed(2)}% complaints over ` +
        `${breakerTripped.sends_24h} sends in the last 24h ` +
        `(limits ${(settings.send_budget.max_bounce_rate * 100).toFixed(0)}% / ` +
        `${(settings.send_budget.max_complaint_rate * 100).toFixed(1)}%).\n\n` +
        `Every workflow except the exempt ones is parked until the bad batch ages out ` +
        `of the rolling 24h window. The breaker cannot clear itself quickly, because ` +
        `pausing sends stops the denominator growing while the bounces stay in it. ` +
        `Find what is bouncing and suppress it.`,
    });
  }

  const failedSince = new Date(now - FAILED_LOOKBACK_HOURS * 3_600_000).toISOString();
  const { count: failedCount } = await supabase
    .from("email_sends")
    .select("id", { count: "exact", head: true })
    .eq("status", "failed")
    .gte("created_at", failedSince);
  if ((failedCount ?? 0) > 0) {
    alerts.push({
      key: "failed_sends",
      line:
        `**${failedCount} send(s) failed** in the last ${FAILED_LOOKBACK_HOURS}h and were not retried. ` +
        `A failed send is dropped, not requeued, so those people simply never got that email.`,
    });
  }

  const overdueBefore = new Date(now - OVERDUE_HOURS * 3_600_000).toISOString();
  const { data: overdue, count: overdueCount } = await supabase
    .from("workflow_enrollments")
    .select("next_run_at", { count: "exact" })
    .eq("status", "active")
    .lte("next_run_at", overdueBefore)
    .order("next_run_at", { ascending: true })
    .limit(1);
  if ((overdueCount ?? 0) > 0) {
    const oldest = overdue?.[0]?.next_run_at;
    const hours = oldest ? Math.round((now - new Date(oldest).getTime()) / 3_600_000) : OVERDUE_HOURS;
    alerts.push({
      key: "overdue",
      line:
        `**${overdueCount} enrollment(s) are overdue** by more than ${OVERDUE_HOURS}h ` +
        `(oldest: ${hours}h late). Steps are being deferred rather than run — check the ` +
        `breaker and the daily send budget.`,
    });
  }

  const raw = await getState(supabase, STATE_KEY);
  const prior = (raw && typeof raw === "object" ? raw : null) as AlertState | null;
  const signature = alerts.map((a) => a.key).sort().join(",");

  if (alerts.length === 0) {
    if (prior) {
      // Clear the state BEFORE notifying, never after. The recovery note is the
      // one email in here that fires when nothing is wrong, so if the two steps
      // can only half-happen, the safe half is "state cleared, note lost" —
      // never "note sent, state kept", which re-notifies on every tick forever.
      // (It did: on 29 July this sent one recovery email every 5 minutes,
      // because the clear wrote SQL NULL into a NOT NULL column and the error
      // was swallowed.)
      await clearState(supabase, STATE_KEY);
      await notifyOwner(
        supabase,
        "CRM pipeline recovered",
        `The send pipeline is healthy again.\n\nCleared: ${prior.signature}\n\n` +
          `No breaker trip, no failed sends in the last ${FAILED_LOOKBACK_HOURS}h, ` +
          `and nothing overdue by more than ${OVERDUE_HOURS}h.`
      );
      return { alerts, notified: false, recovered: true };
    }
    return { alerts, notified: false, recovered: false };
  }

  const changed = !prior || prior.signature !== signature;
  const stale = prior ? now - new Date(prior.last_alert_at).getTime() > COOLDOWN_HOURS * 3_600_000 : true;
  if (!changed && !stale) return { alerts, notified: false, recovered: false };

  const body =
    `The CRM send pipeline needs attention.\n\n` +
    alerts.map((a) => `- ${a.line}`).join("\n\n") +
    `\n\nThis alert repeats at most once every ${COOLDOWN_HOURS}h while the problem persists, ` +
    `and you will get a "recovered" note when it clears.`;
  const { sent } = await notifyOwner(supabase, `CRM pipeline alert: ${signature}`, body);
  if (sent) await putState(supabase, STATE_KEY, { signature, last_alert_at: new Date().toISOString() });
  return { alerts, notified: sent, recovered: false };
}

async function getState(supabase: AdminClient, key: string): Promise<unknown> {
  const { data } = await supabase.from("backend_settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

// backend_settings.value is `jsonb not null`, so a state row is cleared by
// deleting it, not by writing null. Both writers throw on failure: this module
// decides whether to email by reading that state back, so a write that fails
// quietly turns one alert into an alert every tick. The tick wraps the health
// check in its own try/catch, so throwing surfaces the fault in summary.errors
// without failing the run.
async function putState(supabase: AdminClient, key: string, value: unknown): Promise<void> {
  const { error } = await supabase
    .from("backend_settings")
    .upsert({ key, value: value as Json, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`could not persist ${key}: ${error.message}`);
}

async function clearState(supabase: AdminClient, key: string): Promise<void> {
  const { error } = await supabase.from("backend_settings").delete().eq("key", key);
  if (error) throw new Error(`could not clear ${key}: ${error.message}`);
}
