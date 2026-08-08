# Booking system (Cal.com → CRM)

Calendar booking links that sync with Google Calendar, put the meeting link
in the invite, and feed the CRM — which sends the reminder emails.

**Why Cal.com** (over GHL calendars / Calendly): API-first with signed
webhooks on the free tier, native Google Calendar two-way sync, the meeting
location (Zoom link) is baked into the calendar event Cal.com creates in the
guest's calendar, and it keeps you on one system — the CRM stays the source
of truth for contacts, sequences and reminders instead of splitting brains
with another tool.

## Architecture

```
Guest books at cal.com/<you>/<event>             Cal.com ⇄ Google Calendar
        │                                         (availability + invites,
        ▼                                          Zoom link in the event)
POST /api/crm/webhooks/calcom  (HMAC-signed, CALCOM_WEBHOOK_SECRET)
        │
        ├─ upsert lead (source: calcom, tags: booked-call + booked-<event>)
        ├─ upsert appointments row (keyed by cal_uid) — shows on the CRM
        │  dashboard + lead timeline
        ├─ sales pipeline: deal filed/advanced (stage matching
        │  book|call|meeting|demo|discovery, else first stage; forward-only)
        │
        ▼
Engine tick (~5 min) → sendBookingReminders()
        ├─ 24h reminder  (inside 24h window, call still >2h out)
        └─ 1h reminder   (final 75 min; if the 24h one never went out it's
                          stamped as covered so nobody gets two back-to-back)
```

Reminders **bypass the send window** (time-critical) but still honour
unsubscribes/bounces via the normal suppression check. Failed sends retry on
the next tick. Cancelled/rescheduled-away bookings never match the scan.

## Go-live checklist

### 1. Apply the migration

The booking columns, indexes and both reminder templates ship inside
`supabase/migrations/002_crm_core.sql` — run it against your Supabase
project if you haven't already.

### 2. Webhook secret + deploy

Generate a random secret (e.g. `openssl rand -hex 24`), keep it in this
repo's `.env.local` as `CALCOM_WEBHOOK_SECRET`, and register it as a real
worker secret:

```sh
grep '^CALCOM_WEBHOOK_SECRET=' .env.local | cut -d= -f2 | npx wrangler secret put CALCOM_WEBHOOK_SECRET
```

Then deploy the worker (`npm run deploy` or `scripts/deploy.sh`).

### 3. Cal.com setup (~15 min, one time)

1. [cal.com/signup](https://cal.com/signup) — pick your username (this is the
   link people see, e.g. `cal.com/yourname`).
2. **Connect Google Calendar**: Settings → Calendars → connect the Google
   account. Check "check for conflicts" on your main calendar and set it as
   the calendar bookings get added to. Busy slots are now never offered.
3. **Meeting link**: either install the **Zoom app** (Settings → Apps) so
   every booking gets a fresh Zoom link, or set the event-type Location to
   **"Link meeting"** and paste your personal Zoom room URL. Both end up in
   the calendar invite the guest receives.
4. **Create event types** — e.g. "Discovery Call" (30 min), "Strategy
   Session" (60 min). Each gets its own shareable link:
   `cal.com/<username>/discovery-call`. Set buffers, minimum notice, and
   booking questions here.
5. **Webhook**: Settings → Developer → Webhooks → New:
   - Subscriber URL: `https://<your-backend-domain>/api/crm/webhooks/calcom`
   - Events: `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`
   - Secret: the `CALCOM_WEBHOOK_SECRET` value from `.env.local`

### 4. Test

Book a slot with a `you+booktest@yourdomain.com` style email. Within a
minute the lead should appear in /crm with the `booked-call` tag, the
appointment on the dashboard, and an activity on the timeline. The reminder
emails fire on the engine tick inside their windows (safe mode applies as
usual — flip it on to dry-run). Delete the test booking in Cal.com and the
appointment flips to `cancelled`.

## Reminder emails

Templates live in the CRM templates UI (category `booking`) — edit freely:

- **Booking reminder — 24 hours**
- **Booking reminder — 1 hour**

Deleting them is safe (built-in fallback copy is used). Booking merge tags,
alongside all the usual lead tags:

| Tag | Renders as |
| --- | --- |
| `{{booking_title}}` | event name, e.g. "Discovery Call" |
| `{{booking_day}}` | "Wednesday 22 July" (guest's timezone) |
| `{{booking_time}}` | "3:00 pm" (guest's timezone) |
| `{{meeting_url}}` | the Zoom/video link |
| `{{reschedule_url}}` / `{{cancel_url}}` | Cal.com self-serve links |

## Hooks for later

- **Pre-call nurture**: create a workflow triggered by `tag_added` =
  `booked-call` (or `booked-discovery-call` for one event type) to send a
  prep email / intake form right after booking.
- **No-show / follow-up**: appointments carry `status`
  (`scheduled|completed|cancelled|no_show|rescheduled`) — mark outcomes on
  the lead page; a post-call follow-up sequence can hang off a tag the same
  way.
- Agents can read `appointments` like any other table for "what's on
  my calendar this week" answers.
