/**
 * Cal.com booking sync + reminder emails.
 *
 * Bookings flow in through /api/crm/webhooks/calcom and land in the
 * `appointments` table (keyed by cal_uid), attached to a lead that is
 * upserted through the normal capture path — so tag triggers, pipeline
 * auto-population and the timeline all behave exactly like any other
 * lead source. The engine tick then sends 24h and 1h reminders with the
 * meeting link, bypassing the send window (reminders are time-critical)
 * but still honouring unsubscribes via sendCrmEmail's suppression check.
 */
import { logActivity } from "./activity";
import { sendCrmEmail } from "./email";
import { upsertLead } from "./leads";
import { ensureLeadOpportunity } from "./engine";
import type { AdminClient, CrmSettings, Lead } from "./types";
import type { Json, Tables } from "@/types/database";

type Appointment = Tables<"appointments">;

/** Tag every booked lead carries; attach workflows to tag_added on this. */
export const BOOKED_TAG = "booked-call";

// ── Cal.com payload (the fields we use; everything else rides along in raw) ──

interface CalAttendee {
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  timeZone?: string;
}

export interface CalBookingPayload {
  uid?: string;
  title?: string;
  type?: string; // event type title, e.g. "Discovery Call"
  eventSlug?: string;
  startTime?: string;
  endTime?: string;
  attendees?: CalAttendee[];
  organizer?: CalAttendee;
  location?: string;
  metadata?: { videoCallUrl?: string } | null;
  videoCallData?: { url?: string } | null;
  responses?: Record<string, unknown> | null;
  rescheduleUid?: string | null;
  cancellationReason?: string | null;
}

export interface CalcomResult {
  handled: boolean;
  action?: "created" | "updated" | "rescheduled" | "cancelled";
  lead_id?: string;
  appointment_id?: string;
  reason?: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function extractMeetingUrl(payload: CalBookingPayload): string | null {
  if (payload.metadata?.videoCallUrl) return payload.metadata.videoCallUrl;
  if (payload.videoCallData?.url) return payload.videoCallData.url;
  if (payload.location && /^https?:\/\//.test(payload.location)) return payload.location;
  return null;
}

/** Free-text answers from the booking form ("anything to share before the call?") */
function extractNotes(payload: CalBookingPayload): string | null {
  const responses = payload.responses || {};
  const parts: string[] = [];
  for (const [key, value] of Object.entries(responses)) {
    if (["name", "email", "location", "guests", "rescheduleReason"].includes(key)) continue;
    const v =
      typeof value === "string"
        ? value
        : value && typeof value === "object" && "value" in value && typeof (value as { value: unknown }).value === "string"
          ? ((value as { value: string }).value)
          : null;
    if (v?.trim()) parts.push(`${key}: ${v.trim()}`);
  }
  return parts.length ? parts.join("\n") : null;
}

/**
 * A booked call is a strong intent signal — file the deal into the stage that
 * looks like a call/meeting stage if the pipeline has one, else let
 * ensureLeadOpportunity default to the first stage (forward-only either way).
 */
async function bookingStageName(supabase: AdminClient): Promise<string | undefined> {
  const { data: stages } = await supabase.from("pipeline_stages").select("name").order("position");
  return stages?.find((s) => /book|call|meeting|demo|discovery/i.test(s.name))?.name;
}

export async function processCalcomEvent(
  supabase: AdminClient,
  triggerEvent: string,
  payload: CalBookingPayload
): Promise<CalcomResult> {
  const uid = payload.uid;
  if (!uid) return { handled: false, reason: "no uid in payload" };

  if (triggerEvent === "BOOKING_CANCELLED") {
    const { data: appt } = await supabase
      .from("appointments")
      .update({ status: "cancelled", updated_at: new Date().toISOString() })
      .eq("cal_uid", uid)
      .select("id, lead_id, title, starts_at")
      .maybeSingle();
    if (!appt) return { handled: false, reason: `no appointment for uid ${uid}` };
    if (appt.lead_id) {
      await logActivity(supabase, {
        lead_id: appt.lead_id,
        activity_type: "booking_cancelled",
        title: `Booking cancelled: ${appt.title}`,
        body: payload.cancellationReason || undefined,
        data: { cal_uid: uid, starts_at: appt.starts_at },
        actor: "calcom",
      });
    }
    return { handled: true, action: "cancelled", appointment_id: appt.id };
  }

  if (triggerEvent !== "BOOKING_CREATED" && triggerEvent !== "BOOKING_RESCHEDULED") {
    return { handled: false, reason: `ignored event ${triggerEvent}` };
  }

  const attendee = payload.attendees?.[0];
  if (!attendee?.email) return { handled: false, reason: "no attendee email" };
  if (!payload.startTime) return { handled: false, reason: "no startTime" };

  const eventName = payload.type || payload.title || "Call";
  const eventSlug = payload.eventSlug || slugify(eventName);

  const { lead } = await upsertLead(
    supabase,
    {
      email: attendee.email,
      name: attendee.name,
      first_name: attendee.firstName,
      last_name: attendee.lastName,
      timezone: attendee.timeZone,
      source: "calcom",
      tags: [BOOKED_TAG, `booked-${eventSlug}`],
      message: extractNotes(payload),
    },
    { actor: "calcom" }
  );

  // A reschedule supersedes the old booking — keep the row for history
  if (payload.rescheduleUid && payload.rescheduleUid !== uid) {
    await supabase
      .from("appointments")
      .update({ status: "rescheduled", updated_at: new Date().toISOString() })
      .eq("cal_uid", payload.rescheduleUid);
  }

  const meetingUrl = extractMeetingUrl(payload);
  const row = {
    lead_id: lead.id,
    title: payload.title || eventName,
    starts_at: payload.startTime,
    ends_at: payload.endTime || null,
    status: "scheduled" as const,
    location: payload.location || null,
    source: "calcom",
    cal_uid: uid,
    event_slug: eventSlug,
    timezone: attendee.timeZone || null,
    meeting_url: meetingUrl,
    reschedule_url: `https://cal.com/reschedule/${uid}`,
    cancel_url: `https://cal.com/booking/${uid}?cancel=true`,
    raw: payload as unknown as Json,
    updated_at: new Date().toISOString(),
  };

  const { data: existing } = await supabase
    .from("appointments")
    .select("id, starts_at")
    .eq("cal_uid", uid)
    .maybeSingle();

  let appointmentId: string;
  let action: CalcomResult["action"];

  if (existing) {
    // Times moved (same-uid reschedule) → reminders are due again
    const timesChanged = existing.starts_at !== payload.startTime;
    const { data: updated, error } = await supabase
      .from("appointments")
      .update({
        ...row,
        ...(timesChanged ? { reminder_24h_sent_at: null, reminder_1h_sent_at: null } : {}),
      })
      .eq("id", existing.id)
      .select("id")
      .single();
    if (error || !updated) throw new Error(`appointment update failed: ${error?.message}`);
    appointmentId = updated.id;
    action = triggerEvent === "BOOKING_RESCHEDULED" || timesChanged ? "rescheduled" : "updated";
  } else {
    const { data: inserted, error } = await supabase
      .from("appointments")
      .insert(row)
      .select("id")
      .single();
    if (error || !inserted) throw new Error(`appointment insert failed: ${error?.message}`);
    appointmentId = inserted.id;
    action = triggerEvent === "BOOKING_RESCHEDULED" ? "rescheduled" : "created";
  }

  await logActivity(supabase, {
    lead_id: lead.id,
    activity_type: action === "rescheduled" ? "booking_rescheduled" : "booking_created",
    title: `${action === "rescheduled" ? "Booking rescheduled" : "Booking"}: ${row.title}`,
    data: { cal_uid: uid, starts_at: row.starts_at, meeting_url: meetingUrl, event_slug: eventSlug },
    actor: "calcom",
  });

  // Never fail the webhook over a pipeline write
  try {
    await ensureLeadOpportunity(supabase, lead, {
      stage: await bookingStageName(supabase),
      actor: "calcom",
    });
  } catch (e) {
    console.error("calcom: ensureLeadOpportunity failed", e);
  }

  return { handled: true, action, lead_id: lead.id, appointment_id: appointmentId };
}

// ── Reminders ────────────────────────────────────────────────────────────────

const TEMPLATE_24H = "Booking reminder — 24 hours";
const TEMPLATE_1H = "Booking reminder — 1 hour";

// Fallback copy if the seeded templates get deleted — same merge tags
const FALLBACK: Record<string, { subject: string; body: string }> = {
  [TEMPLATE_24H]: {
    subject: "Tomorrow: {{booking_title}}",
    body: "Hey {{first_name|there}},\n\nQuick reminder that our call is booked for tomorrow: **{{booking_title}}**, {{booking_day}} at {{booking_time}}.\n\nJoin here when it's time: {{meeting_url}}\n\nNeed to change it? [Reschedule]({{reschedule_url}}) or [cancel]({{cancel_url}}) in one click.\n\nSee you there!",
  },
  [TEMPLATE_1H]: {
    subject: "Starting soon: {{booking_title}} at {{booking_time}}",
    body: "Hey {{first_name|there}},\n\nWe're on in about an hour — **{{booking_title}}** at {{booking_time}}.\n\nJoin link: {{meeting_url}}\n\nSee you soon!",
  },
};

function fmtBookingDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(iso));
}

function fmtBookingTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function bookingMergeValues(appt: Appointment, lead: Lead): Record<string, string> {
  const tz = appt.timezone || lead.timezone || "UTC";
  let day = "";
  let time = "";
  try {
    day = fmtBookingDay(appt.starts_at, tz);
    time = fmtBookingTime(appt.starts_at, tz);
  } catch {
    day = fmtBookingDay(appt.starts_at, "UTC");
    time = fmtBookingTime(appt.starts_at, "UTC");
  }
  return {
    booking_title: appt.title,
    booking_day: day,
    booking_time: time,
    meeting_url: appt.meeting_url || "",
    reschedule_url: appt.reschedule_url || "",
    cancel_url: appt.cancel_url || "",
  };
}

export interface ReminderSummary {
  sent: number;
  simulated: number;
  errors: string[];
}

const HOUR = 3_600_000;

/**
 * Sends due booking reminders. Called from the engine tick (~every 10 min).
 * 24h reminder: fires inside the 24h window while the call is still >2h out
 * (a booking made 90 minutes ahead skips straight to the 1h reminder).
 * 1h reminder: fires inside the final 75 minutes.
 * Failed sends stay unstamped and retry next tick; a cancelled or
 * rescheduled-away appointment never matches the status filter.
 */
export async function sendBookingReminders(
  supabase: AdminClient,
  settings: CrmSettings
): Promise<ReminderSummary> {
  const summary: ReminderSummary = { sent: 0, simulated: 0, errors: [] };
  const now = Date.now();

  const { data: upcoming, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("status", "scheduled")
    .not("cal_uid", "is", null)
    .gt("starts_at", new Date(now).toISOString())
    .lte("starts_at", new Date(now + 24 * HOUR).toISOString())
    .or("reminder_24h_sent_at.is.null,reminder_1h_sent_at.is.null");
  if (error) {
    summary.errors.push(`fetch upcoming bookings: ${error.message}`);
    return summary;
  }
  if (!upcoming?.length) return summary;

  const leadIds = Array.from(new Set(upcoming.map((a) => a.lead_id).filter(Boolean))) as string[];
  const { data: leads } = await supabase.from("leads").select("*").in("id", leadIds);
  const leadById = new Map((leads || []).map((l) => [l.id, l]));

  const { data: templates } = await supabase
    .from("email_templates")
    .select("*")
    .in("name", [TEMPLATE_24H, TEMPLATE_1H]);
  const templateByName = new Map((templates || []).map((t) => [t.name, t]));

  for (const appt of upcoming as Appointment[]) {
    const lead = appt.lead_id ? leadById.get(appt.lead_id) : undefined;
    if (!lead) continue;

    const msUntil = new Date(appt.starts_at).getTime() - now;
    let templateName: string | null = null;
    const stamp: Record<string, string> = {};

    if (msUntil <= 1.25 * HOUR && !appt.reminder_1h_sent_at) {
      templateName = TEMPLATE_1H;
      stamp.reminder_1h_sent_at = new Date().toISOString();
      // If the 24h reminder never went out (booked late, engine downtime),
      // don't send two emails back to back — stamp it as covered.
      if (!appt.reminder_24h_sent_at) stamp.reminder_24h_sent_at = new Date().toISOString();
    } else if (msUntil > 2 * HOUR && !appt.reminder_24h_sent_at) {
      templateName = TEMPLATE_24H;
      stamp.reminder_24h_sent_at = new Date().toISOString();
    }
    if (!templateName) continue;

    const tpl = templateByName.get(templateName);
    const subject = tpl?.subject || FALLBACK[templateName].subject;
    const bodyMd = tpl?.body_md || FALLBACK[templateName].body;
    const extra = bookingMergeValues(appt, lead);

    try {
      const result = await sendCrmEmail(
        supabase,
        {
          lead,
          // Booking merge tags are rendered here; lead tags render in sendCrmEmail
          subject: renderExtraTags(subject, extra),
          bodyMd: renderExtraTags(bodyMd, extra),
          preheader: tpl?.preheader ? renderExtraTags(tpl.preheader, extra) : null,
          templateId: tpl?.id || null,
          actor: "booking-reminder",
        },
        settings
      );
      if (result.status === "failed") {
        summary.errors.push(`${lead.email} (${templateName}): ${result.error}`);
        continue; // leave unstamped → retried next tick
      }
      if (result.status === "sent") summary.sent++;
      if (result.status === "simulated") summary.simulated++;
      await supabase.from("appointments").update(stamp).eq("id", appt.id);
    } catch (e) {
      summary.errors.push(`${lead.email} (${templateName}): ${e instanceof Error ? e.message : "send error"}`);
    }
  }

  return summary;
}

/** Substitute booking-specific tags before the lead merge pass runs. */
function renderExtraTags(text: string, extra: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\s*\}\}/g, (match, key: string, fallback?: string) => {
    if (key in extra) return extra[key] || fallback || "";
    return match; // leave lead tags for renderMergeTags
  });
}
