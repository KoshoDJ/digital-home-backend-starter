import type { AdminClient, CrmSettings, CrmSender, SendBudget, SendWindow } from "./types";

const DEFAULT_SENDER: CrmSender = {
  from_name: "Your Brand",
  from_email: "you@yourdomain.com",
  reply_to: "you@yourdomain.com",
};

const DEFAULT_WINDOW: SendWindow = {
  enabled: false,
  start_hour: 8,
  end_hour: 18,
  timezone: "UTC",
  days: [1, 2, 3, 4, 5],
};

// Reputation guard: hard ceiling on engine sends regardless of what's enrolled.
const DEFAULT_BUDGET: SendBudget = {
  enabled: true,
  daily_limit: 300,
  per_tick_limit: 50,
  max_bounce_rate: 0.05, // pause any wave at >5% bounces
  max_complaint_rate: 0.002, // …or >0.2% complaints
  breaker_min_sends: 20,
  // The breaker is global: one bad bulk list can hold the rolling bounce rate
  // over threshold for days and park EVERY send_email step — including
  // time-critical activation/onboarding emails to people who just signed up.
  // List workflow ids here (backend_settings.crm_send_budget) to exempt them.
  exempt_workflow_ids: [],
  suppress_tags: ["suppressed-dead-list"],
};

export async function getCrmSettings(supabase: AdminClient): Promise<CrmSettings> {
  const { data } = await supabase
    .from("backend_settings")
    .select("key, value")
    .in("key", [
      "crm_safe_mode",
      "crm_sender",
      "crm_send_window",
      "crm_send_budget",
      "crm_capture_key",
      "crm_funnel_secret",
    ]);

  const map = new Map((data || []).map((r) => [r.key, r.value]));

  const sender = { ...DEFAULT_SENDER, ...((map.get("crm_sender") as object) || {}) } as CrmSender;
  const send_window = { ...DEFAULT_WINDOW, ...((map.get("crm_send_window") as object) || {}) } as SendWindow;
  const send_budget = { ...DEFAULT_BUDGET, ...((map.get("crm_send_budget") as object) || {}) } as SendBudget;

  return {
    // Default to safe mode unless explicitly disabled
    safe_mode: map.get("crm_safe_mode") !== false,
    sender,
    send_window,
    send_budget,
    capture_key: typeof map.get("crm_capture_key") === "string" ? (map.get("crm_capture_key") as string) : null,
    funnel_secret: typeof map.get("crm_funnel_secret") === "string" ? (map.get("crm_funnel_secret") as string) : null,
  };
}
