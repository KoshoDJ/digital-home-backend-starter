-- Migration 002: CRM core + funnel analytics + social publishing + bookings.
--
-- Turns the lead tables into a full CRM: pipelines, timeline activities,
-- custom fields, tag registry, nurture workflows with enrollments, email
-- templates, A/B subject testing, tasks and appointments (with Cal.com
-- booking sync), plus anonymous funnel analytics and the short-form social
-- publishing engine.
--
-- Assumes the Digital Home frontend starter's base migrations have run
-- (they create `leads`, `email_sends`, the `send_status` enum and the
-- `update_updated_at()` trigger function).
--
-- Written to be re-runnable (if not exists / on conflict do nothing).

-- ── Enums ────────────────────────────────────────────────────────────────────

do $$ begin
  create type email_subscription_status as enum ('subscribed', 'unsubscribed', 'bounced', 'complained');
exception when duplicate_object then null; end $$;

do $$ begin
  create type opportunity_status as enum ('open', 'won', 'lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type workflow_status as enum ('draft', 'active', 'paused', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type enrollment_status as enum ('active', 'completed', 'exited', 'failed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type crm_task_status as enum ('open', 'done');
exception when duplicate_object then null; end $$;

do $$ begin
  create type appointment_status as enum ('scheduled', 'completed', 'cancelled', 'no_show');
exception when duplicate_object then null; end $$;

-- email_sends gains outcomes for safe mode + suppression
alter type send_status add value if not exists 'simulated';
alter type send_status add value if not exists 'suppressed';

-- ── Extend leads into a full contact record ──────────────────────────────────

alter table leads add column if not exists phone text;
alter table leads add column if not exists company text;
alter table leads add column if not exists custom jsonb not null default '{}';
alter table leads add column if not exists email_status email_subscription_status not null default 'subscribed';
alter table leads add column if not exists unsubscribe_token uuid not null default uuid_generate_v4();
alter table leads add column if not exists timezone text;
alter table leads add column if not exists last_activity_at timestamptz not null default now();

create unique index if not exists idx_leads_unsub_token on leads(unsubscribe_token);
create index if not exists idx_leads_last_activity on leads(last_activity_at desc);
create index if not exists idx_leads_tags on leads using gin(tags);
create index if not exists idx_leads_email_status on leads(email_status);

-- ── Custom field definitions (schema for leads.custom) ──────────────────────

create table if not exists crm_custom_fields (
  id uuid primary key default uuid_generate_v4(),
  key text unique not null,                -- snake_case key inside leads.custom
  label text not null,
  field_type text not null default 'text', -- text|number|date|select|multiselect|boolean|url
  options jsonb not null default '[]',     -- for select/multiselect
  sort_order integer not null default 0,
  created_at timestamptz default now()
);

-- ── Tag registry (leads.tags stays text[]; this adds metadata + autocomplete)

create table if not exists crm_tags (
  id uuid primary key default uuid_generate_v4(),
  name text unique not null,
  color text,
  created_at timestamptz default now()
);

-- ── Pipelines / stages / opportunities ───────────────────────────────────────

create table if not exists pipelines (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  is_default boolean not null default false,
  position integer not null default 0,
  created_at timestamptz default now()
);

create table if not exists pipeline_stages (
  id uuid primary key default uuid_generate_v4(),
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  name text not null,
  position integer not null default 0,
  created_at timestamptz default now()
);

create index if not exists idx_stages_pipeline on pipeline_stages(pipeline_id, position);

create table if not exists opportunities (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  pipeline_id uuid not null references pipelines(id) on delete cascade,
  stage_id uuid not null references pipeline_stages(id) on delete cascade,
  name text not null,
  value_cents bigint not null default 0,
  currency text not null default 'USD',
  status opportunity_status not null default 'open',
  position integer not null default 0,
  won_at timestamptz,
  lost_at timestamptz,
  lost_reason text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_opps_stage on opportunities(stage_id, position);
create index if not exists idx_opps_lead on opportunities(lead_id);
create index if not exists idx_opps_status on opportunities(status);

drop trigger if exists opportunities_updated_at on opportunities;
create trigger opportunities_updated_at
  before update on opportunities
  for each row execute function update_updated_at();

-- ── Lead timeline ─────────────────────────────────────────────────────────────

create table if not exists lead_activities (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid not null references leads(id) on delete cascade,
  activity_type text not null,  -- created|note|email_sent|email_opened|email_clicked|form_submitted|
                                -- tag_added|tag_removed|status_changed|stage_changed|enrolled|workflow_completed|
                                -- task_created|appointment_booked|field_updated|unsubscribed|webhook|ai
  title text not null,
  body text,
  data jsonb not null default '{}',
  actor text not null default 'system',   -- human | system | agent:<name>
  created_at timestamptz default now()
);

create index if not exists idx_activities_lead on lead_activities(lead_id, created_at desc);
create index if not exists idx_activities_created on lead_activities(created_at desc);
create index if not exists idx_activities_type on lead_activities(activity_type);

-- ── Email templates (markdown source, rendered at send time) ─────────────────

create table if not exists email_templates (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  subject text not null,
  preheader text,
  body_md text not null,
  category text,
  ai_generated boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

drop trigger if exists email_templates_updated_at on email_templates;
create trigger email_templates_updated_at
  before update on email_templates
  for each row execute function update_updated_at();

-- ── Workflows (nurture automations) ──────────────────────────────────────────

create table if not exists workflows (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  description text,
  status workflow_status not null default 'draft',
  trigger_type text not null default 'manual',  -- manual|lead_created|form_submitted|tag_added|status_changed|stage_changed
  trigger_config jsonb not null default '{}',   -- e.g. {"tag":"downloaded-guide"} {"form":"newsletter"} {"stage_id":"..."}
  steps jsonb not null default '[]',            -- ordered [{id,type,config}] — types: send_email|wait|add_tag|remove_tag|
                                                -- set_status|move_stage|update_field|webhook|create_task
  allow_reenrollment boolean not null default false,
  ai_brief jsonb,                               -- the brief that generated this workflow (if AI-drafted)
  enrolled_count integer not null default 0,
  completed_count integer not null default 0,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_workflows_status on workflows(status);
create index if not exists idx_workflows_trigger on workflows(trigger_type) where status = 'active';

drop trigger if exists workflows_updated_at on workflows;
create trigger workflows_updated_at
  before update on workflows
  for each row execute function update_updated_at();

create table if not exists workflow_enrollments (
  id uuid primary key default uuid_generate_v4(),
  workflow_id uuid not null references workflows(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  status enrollment_status not null default 'active',
  current_step integer not null default 0,      -- index of the NEXT step to execute
  next_run_at timestamptz not null default now(),
  context jsonb not null default '{}',
  last_error text,
  enrolled_at timestamptz default now(),
  completed_at timestamptz
);

create index if not exists idx_enroll_due on workflow_enrollments(next_run_at) where status = 'active';
create index if not exists idx_enroll_lead on workflow_enrollments(lead_id);
create index if not exists idx_enroll_workflow on workflow_enrollments(workflow_id, status);
create unique index if not exists idx_enroll_active_unique on workflow_enrollments(workflow_id, lead_id) where status = 'active';

-- ── Tasks (for humans and agents) ────────────────────────────────────────────

create table if not exists crm_tasks (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid references leads(id) on delete cascade,
  title text not null,
  description text,
  status crm_task_status not null default 'open',
  due_at timestamptz,
  created_by text not null default 'human',
  completed_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists idx_tasks_open on crm_tasks(status, due_at);
create index if not exists idx_tasks_lead on crm_tasks(lead_id);

-- ── Appointments (bookings recorded from any source) ─────────────────────────

create table if not exists appointments (
  id uuid primary key default uuid_generate_v4(),
  lead_id uuid references leads(id) on delete cascade,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  status appointment_status not null default 'scheduled',
  location text,
  notes text,
  source text,
  created_at timestamptz default now()
);

create index if not exists idx_appts_time on appointments(starts_at);
create index if not exists idx_appts_lead on appointments(lead_id);

-- ── Extend email_sends for the workflow engine ───────────────────────────────

alter table email_sends add column if not exists workflow_id uuid references workflows(id);
alter table email_sends add column if not exists enrollment_id uuid references workflow_enrollments(id);
alter table email_sends add column if not exists email_template_id uuid references email_templates(id);
alter table email_sends add column if not exists body_html text;
alter table email_sends add column if not exists opened_at timestamptz;
alter table email_sends add column if not exists clicked_at timestamptz;

create index if not exists idx_sends_workflow on email_sends(workflow_id);
create index if not exists idx_sends_created on email_sends(created_at desc);

-- ── A/B subject-line testing inside workflows ────────────────────────────────
-- A template with subject_b set is an active test: the engine alternates
-- subjects per send and records which variant went out; the tick auto-promotes
-- the winner once both variants have enough opens data.

alter table email_templates add column if not exists subject_b text;

alter table email_sends add column if not exists variant text
  check (variant in ('a', 'b'));

comment on column email_templates.subject_b is
  'Challenger subject line. Non-null = A/B test running; cleared on promotion.';
comment on column email_sends.variant is
  'Which subject variant this send used (a = subject, b = subject_b).';

-- ── Funnel analytics ─────────────────────────────────────────────────────────
-- Anonymous per-session funnel events (any funnel, keyed by `funnel`). Rows
-- are written by POST /api/crm/funnel/ingest and read by the /crm/funnel
-- dashboard. Events are deduped client-side (each fires at most once per
-- session), so a row count per step equals distinct sessions reaching it.

create table if not exists funnel_events (
  id uuid primary key default uuid_generate_v4(),
  funnel text not null default 'unknown',   -- funnel key, e.g. 'my-quiz'
  session_id text not null,                 -- anonymous per-tab session id
  event_type text not null,                 -- start | view | complete | cta_click
  screen_index integer,                     -- view events: 0-based step position
  screen_id text,                           -- view events: stable screen slug
  event_data jsonb not null default '{}',   -- anything else (cta location, step…)
  page_url text,
  referrer text,
  created_at timestamptz not null default now()
);

create index if not exists idx_funnel_events_funnel_time on funnel_events(funnel, created_at desc);
create index if not exists idx_funnel_events_step on funnel_events(funnel, event_type, screen_index);
create index if not exists idx_funnel_events_session on funnel_events(session_id);

alter table funnel_events enable row level security;

-- ── Cal.com booking integration ──────────────────────────────────────────────
-- Bookings made through Cal.com links land in `appointments` via the
-- /api/crm/webhooks/calcom endpoint. Reschedules keep history: the superseded
-- appointment row is marked 'rescheduled' rather than deleted.

alter type appointment_status add value if not exists 'rescheduled';

alter table appointments
  add column if not exists cal_uid text,
  add column if not exists event_slug text,
  add column if not exists timezone text,
  add column if not exists meeting_url text,
  add column if not exists reschedule_url text,
  add column if not exists cancel_url text,
  add column if not exists raw jsonb,
  add column if not exists reminder_24h_sent_at timestamptz,
  add column if not exists reminder_1h_sent_at timestamptz,
  add column if not exists updated_at timestamptz default now();

-- Webhook upserts are keyed on the Cal.com booking uid
create unique index if not exists idx_appts_cal_uid
  on appointments(cal_uid) where cal_uid is not null;

-- The reminder scan runs every engine tick: upcoming scheduled appointments only
create index if not exists idx_appts_upcoming
  on appointments(starts_at) where cal_uid is not null;

-- Reminder templates: looked up by exact name at send time; editable in the
-- CRM templates UI. If a template is deleted the engine falls back to
-- built-in copy, so these are safe to reword freely.
insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking reminder — 24 hours',
  'Tomorrow: {{booking_title}}',
  'Your call is coming up',
  E'Hey {{first_name|there}},\n\nJust a quick reminder that our call is booked for tomorrow:\n\n**{{booking_title}}**\n{{booking_day}} at {{booking_time}}\n\nJoin here when it''s time: {{meeting_url}}\n\nNeed to change it? You can [reschedule]({{reschedule_url}}) or [cancel]({{cancel_url}}) in one click — no hard feelings, just let the calendar know.\n\nSee you there!',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking reminder — 24 hours');

insert into email_templates (name, subject, preheader, body_md, category)
select
  'Booking reminder — 1 hour',
  'Starting soon: {{booking_title}} at {{booking_time}}',
  'We''re on in about an hour',
  E'Hey {{first_name|there}},\n\nWe''re on in about an hour — **{{booking_title}}** at {{booking_time}}.\n\nJoin link: {{meeting_url}}\n\nGrab a coffee, find a quiet spot, and see you soon.',
  'booking'
where not exists (select 1 from email_templates where name = 'Booking reminder — 1 hour');

-- ── Social publishing — the short-form distribution engine ───────────────────
-- Schedule a piece of content once, publish it to Instagram, Facebook and
-- YouTube Shorts, and track how each copy performs. social_accounts:
-- connected platform identities with their tokens. social_posts: one piece
-- of content (video or carousel + caption + schedule). social_post_targets:
-- the per-platform publish attempts — each is its own little state machine
-- because Meta processes uploads asynchronously. social_metrics:
-- point-in-time performance snapshots per target.

create table if not exists social_accounts (
  id uuid primary key default uuid_generate_v4(),
  platform text not null check (platform in ('instagram', 'facebook', 'youtube')),
  external_id text not null,                 -- IG user id / FB page id / YT channel id
  name text not null,                        -- display name shown in the studio
  username text,                             -- @handle where the platform has one
  access_token text,                         -- Meta: long-lived page token. YouTube: unused (see refresh_token)
  refresh_token text,                        -- YouTube: offline refresh token
  token_expires_at timestamptz,              -- null = long-lived / unknown
  status text not null default 'active' check (status in ('active', 'error', 'disconnected')),
  metadata jsonb not null default '{}',      -- page id backing an IG account, channel thumbnails, scopes…
  connected_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (platform, external_id)
);

create table if not exists social_posts (
  id uuid primary key default uuid_generate_v4(),
  title text,                                -- internal label; doubles as the YouTube title
  caption text not null default '',
  video_path text,                           -- storage object path in the social-videos bucket
  video_url text,                            -- public URL Meta pulls from / we stream to YouTube
  thumbnail_url text,
  post_type text not null default 'video'
    check (post_type in ('video', 'carousel')),
  status text not null default 'draft'
    check (status in ('draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'canceled')),
  scheduled_at timestamptz,                  -- null while draft
  published_at timestamptz,                  -- set when the last target lands
  created_by text not null default 'human',  -- 'human' | agent name, mirrors content_calendar
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_social_posts_due
  on social_posts (scheduled_at) where status in ('scheduled', 'publishing');
create index if not exists idx_social_posts_created on social_posts (created_at desc);

-- Multi-slide carousel posts: a post is either a 'video' (single Reel) or a
-- 'carousel' whose ordered slides live here. Carousels publish to Instagram
-- (CAROUSEL container) and Facebook (multi-photo page post); YouTube has no
-- carousel analogue, so the engine marks YouTube targets 'skipped'.
create table if not exists social_post_media (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid not null references social_posts(id) on delete cascade,
  position integer not null default 0,
  kind text not null default 'image' check (kind in ('image', 'video')),
  path text,                -- storage object path in the social-videos bucket (null for external URLs)
  url text not null,        -- public URL the platforms pull from
  created_at timestamptz not null default now(),
  unique (post_id, position)
);

create index if not exists idx_social_post_media_post
  on social_post_media (post_id, position);

create table if not exists social_post_targets (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid not null references social_posts(id) on delete cascade,
  account_id uuid not null references social_accounts(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'facebook', 'youtube')),
  status text not null default 'pending'
    check (status in ('pending', 'publishing', 'processing', 'published', 'failed', 'skipped')),
  caption_override text,                     -- null = use the post caption
  external_id text,                          -- IG media id / FB video id / YT video id
  external_url text,                         -- permalink once live
  platform_ref jsonb not null default '{}',  -- in-flight state: IG container id, FB upload session…
  error text,
  attempts integer not null default 0,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (post_id, account_id)
);

create index if not exists idx_social_targets_post on social_post_targets (post_id);
create index if not exists idx_social_targets_active
  on social_post_targets (status) where status in ('pending', 'publishing', 'processing');

create table if not exists social_metrics (
  id uuid primary key default uuid_generate_v4(),
  target_id uuid not null references social_post_targets(id) on delete cascade,
  captured_at timestamptz not null default now(),
  views bigint not null default 0,
  likes bigint not null default 0,
  comments bigint not null default 0,
  shares bigint not null default 0,
  saves bigint not null default 0,
  reach bigint not null default 0,
  raw jsonb not null default '{}'            -- untouched platform payload for later analysis
);

create index if not exists idx_social_metrics_target
  on social_metrics (target_id, captured_at desc);

drop trigger if exists social_accounts_updated_at on social_accounts;
create trigger social_accounts_updated_at
  before update on social_accounts
  for each row execute function update_updated_at();

drop trigger if exists social_posts_updated_at on social_posts;
create trigger social_posts_updated_at
  before update on social_posts
  for each row execute function update_updated_at();

drop trigger if exists social_post_targets_updated_at on social_post_targets;
create trigger social_post_targets_updated_at
  before update on social_post_targets
  for each row execute function update_updated_at();

alter table social_accounts enable row level security;
alter table social_posts enable row level security;
alter table social_post_targets enable row level security;
alter table social_metrics enable row level security;
alter table social_post_media enable row level security;

-- All access goes through API routes using the service role; no anon policies.

-- Public bucket for the videos themselves. Public because Instagram and
-- Facebook ingest by pulling a hosted URL — objects use unguessable
-- uuid-prefixed paths. Uploads happen via signed upload URLs minted by the
-- backend, so no storage RLS policies are needed.
insert into storage.buckets (id, name, public)
values ('social-videos', 'social-videos', true)
on conflict (id) do nothing;

comment on table social_posts is 'Short-form distribution: one post scheduled across IG / FB / YouTube Shorts.';
comment on column social_post_targets.platform_ref is 'In-flight publish state (e.g. IG creation container id) carried between ticks.';

-- ── Row level security (service-role access only, like the rest) ─────────────

alter table crm_custom_fields enable row level security;
alter table crm_tags enable row level security;
alter table pipelines enable row level security;
alter table pipeline_stages enable row level security;
alter table opportunities enable row level security;
alter table lead_activities enable row level security;
alter table email_templates enable row level security;
alter table workflows enable row level security;
alter table workflow_enrollments enable row level security;
alter table crm_tasks enable row level security;
alter table appointments enable row level security;

-- ── Seeds ────────────────────────────────────────────────────────────────────

insert into pipelines (name, is_default, position)
select 'Sales Pipeline', true, 0
where not exists (select 1 from pipelines);

insert into pipeline_stages (pipeline_id, name, position)
select p.id, s.name, s.pos
from pipelines p,
     (values ('New', 0), ('Nurturing', 1), ('Call Booked', 2), ('Proposal', 3), ('Negotiation', 4)) as s(name, pos)
where p.is_default
  and not exists (select 1 from pipeline_stages where pipeline_id = p.id);

insert into backend_settings (key, value) values
  ('crm_safe_mode', 'true'::jsonb),
  ('crm_sender', '{"from_name": "Your Brand", "from_email": "you@yourdomain.com", "reply_to": "you@yourdomain.com"}'::jsonb),
  ('crm_send_window', '{"enabled": false, "start_hour": 8, "end_hour": 18, "timezone": "UTC", "days": [1,2,3,4,5]}'::jsonb)
on conflict (key) do nothing;
