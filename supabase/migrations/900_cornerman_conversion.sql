-- Member migration: CornerMan enrollment-conversion contract v1.
-- Additive. Existing workflows stay purpose = general. Rollback is a transaction
-- abort of this file, not a destructive down migration.

create type workflow_purpose as enum (
  'general',
  'prospect_nurture',
  'customer_onboarding',
  'transactional'
);

alter table workflows
  add column purpose workflow_purpose not null default 'general';

alter table workflow_enrollments
  add column exited_at timestamptz,
  add column exit_reason text,
  add column exit_event_id uuid;

create table conversion_receipts (
  id uuid primary key default uuid_generate_v4(),
  producer text not null,
  environment text not null,
  event_id uuid not null,
  schema_version integer not null,
  payload_hash text not null,
  digital_home_lead_id uuid not null references leads(id) on delete cascade,
  cornerman_enrollment_id uuid not null,
  cornerman_enrollment_version integer not null,
  correlation_id uuid not null,
  received_at timestamptz not null default now(),
  applied_at timestamptz,
  result_status text not null,
  prospect_nurture_exited integer not null default 0,
  in_flight_reservations integer not null default 0,
  diagnostics jsonb not null default '{}',
  unique (producer, environment, event_id),
  check (producer = 'cornerman'),
  check (result_status in ('pending', 'applied', 'needs_review')),
  check (schema_version = 1)
);

create index conversion_receipts_event_id on conversion_receipts (event_id);
create index conversion_receipts_lead_id on conversion_receipts (digital_home_lead_id);

alter table conversion_receipts enable row level security;
revoke all on table conversion_receipts from public, anon, authenticated;
grant all on table conversion_receipts to service_role;

create type dispatch_reservation_status as enum (
  'reserved',
  'sent',
  'simulated',
  'suppressed',
  'failed',
  'expired'
);

create table workflow_dispatch_reservations (
  id uuid primary key default uuid_generate_v4(),
  enrollment_id uuid not null references workflow_enrollments(id) on delete cascade,
  lead_id uuid not null references leads(id) on delete cascade,
  workflow_id uuid not null references workflows(id) on delete cascade,
  step_number integer not null,
  status dispatch_reservation_status not null default 'reserved',
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  outcome_at timestamptz,
  unique (enrollment_id, step_number)
);

create index workflow_dispatch_reservations_lead on workflow_dispatch_reservations (lead_id, status);

alter table workflow_dispatch_reservations enable row level security;
revoke all on table workflow_dispatch_reservations from public, anon, authenticated;
grant all on table workflow_dispatch_reservations to service_role;

create or replace function public.apply_cornerman_conversion_v1(
  p_producer text,
  p_environment text,
  p_event_id uuid,
  p_schema_version integer,
  p_payload_hash text,
  p_lead_id uuid,
  p_cornerman_enrollment_id uuid,
  p_cornerman_enrollment_version integer,
  p_correlation_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_lead public.leads%rowtype;
  v_existing public.conversion_receipts%rowtype;
  v_receipt public.conversion_receipts%rowtype;
  v_exited integer := 0;
  v_in_flight integer := 0;
  v_result text;
begin
  if p_producer is distinct from 'cornerman' or p_schema_version is distinct from 1 then
    raise exception 'invalid conversion contract';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  insert into public.conversion_receipts (
    producer, environment, event_id, schema_version, payload_hash,
    digital_home_lead_id, cornerman_enrollment_id, cornerman_enrollment_version,
    correlation_id, result_status
  ) values (
    p_producer, p_environment, p_event_id, p_schema_version, p_payload_hash,
    p_lead_id, p_cornerman_enrollment_id, p_cornerman_enrollment_version,
    p_correlation_id, 'pending'
  )
  on conflict (producer, environment, event_id) do nothing
  returning * into v_receipt;

  if v_receipt.id is null then
    select * into v_existing
    from public.conversion_receipts
    where producer = p_producer and environment = p_environment and event_id = p_event_id
    for update;
    if v_existing.payload_hash is distinct from p_payload_hash then
      return jsonb_build_object('ok', false, 'code', 'conflict');
    end if;
    return jsonb_build_object('ok', true, 'code', 'replay', 'receipt', to_jsonb(v_existing));
  end if;

  update public.leads
    set status = 'converted', updated_at = now()
    where id = p_lead_id;

  select count(*)::integer into v_in_flight
  from public.workflow_dispatch_reservations r
  join public.workflow_enrollments e on e.id = r.enrollment_id
  join public.workflows w on w.id = e.workflow_id
  where e.lead_id = p_lead_id
    and e.status = 'active'
    and w.purpose = 'prospect_nurture'
    and r.step_number >= e.current_step
    and (
      (r.status = 'reserved' and r.expires_at > now())
      or r.status in ('sent', 'simulated')
    );

  update public.workflow_enrollments e
  set
    status = 'exited',
    exited_at = now(),
    exit_reason = 'cornerman_conversion',
    exit_event_id = p_event_id
  from public.workflows w
  where e.workflow_id = w.id
    and e.lead_id = p_lead_id
    and e.status = 'active'
    and w.purpose = 'prospect_nurture';
  get diagnostics v_exited = row_count;

  v_result := case when v_in_flight > 0 then 'needs_review' else 'applied' end;

  insert into public.lead_activities (lead_id, activity_type, title, data, actor)
  values (
    p_lead_id,
    'status_changed',
    'Lead converted',
    jsonb_build_object('source', 'cornerman', 'event_id', p_event_id, 'result_status', v_result),
    'system'
  );

  update public.conversion_receipts
  set
    applied_at = now(),
    result_status = v_result,
    prospect_nurture_exited = v_exited,
    in_flight_reservations = v_in_flight,
    diagnostics = jsonb_build_object('exit_reason', 'cornerman_conversion')
  where id = v_receipt.id
  returning * into v_receipt;

  return jsonb_build_object('ok', true, 'code', v_result, 'receipt', to_jsonb(v_receipt));
end;
$$;

revoke all on function public.apply_cornerman_conversion_v1(text, text, uuid, integer, text, uuid, uuid, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.apply_cornerman_conversion_v1(text, text, uuid, integer, text, uuid, uuid, integer, uuid)
  to service_role;

create or replace function public.reserve_workflow_dispatch_v1(
  p_enrollment_id uuid,
  p_step_number integer,
  p_lease_seconds integer default 600
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_enroll public.workflow_enrollments%rowtype;
  v_lead public.leads%rowtype;
  v_res public.workflow_dispatch_reservations%rowtype;
  v_lead_id uuid;
  v_lease interval;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 then
    p_lease_seconds := 600;
  end if;
  v_lease := make_interval(secs => p_lease_seconds);

  -- Lock order matches conversion: lead, then enrollment, then reservation.
  select lead_id into v_lead_id
  from public.workflow_enrollments
  where id = p_enrollment_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_lead from public.leads where id = v_lead_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;

  select * into v_enroll from public.workflow_enrollments where id = p_enrollment_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_enroll.lead_id is distinct from v_lead.id then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_lead.status = 'converted' then
    return jsonb_build_object('ok', false, 'code', 'converted');
  end if;
  if v_enroll.status is distinct from 'active' then
    return jsonb_build_object('ok', false, 'code', 'not_active');
  end if;
  if v_enroll.current_step is distinct from p_step_number then
    return jsonb_build_object('ok', false, 'code', 'step_mismatch');
  end if;

  select * into v_res
  from public.workflow_dispatch_reservations
  where enrollment_id = p_enrollment_id and step_number = p_step_number
  for update;

  if found then
    if v_res.status in ('sent', 'simulated', 'suppressed') then
      return jsonb_build_object('ok', false, 'code', 'already_dispatched', 'reservation_id', v_res.id);
    end if;
    if v_res.status = 'reserved' and v_res.expires_at > now() then
      return jsonb_build_object(
        'ok', false,
        'code', 'already_reserved',
        'reservation_id', v_res.id,
        'expires_at', v_res.expires_at
      );
    end if;
    update public.workflow_dispatch_reservations
    set
      status = 'reserved',
      reserved_at = now(),
      expires_at = now() + v_lease,
      outcome_at = null
    where id = v_res.id
    returning * into v_res;
    return jsonb_build_object(
      'ok', true,
      'code', 'reserved',
      'reservation_id', v_res.id,
      'recovered', true,
      'expires_at', v_res.expires_at
    );
  end if;

  insert into public.workflow_dispatch_reservations (
    enrollment_id, lead_id, workflow_id, step_number, status, expires_at
  ) values (
    v_enroll.id, v_enroll.lead_id, v_enroll.workflow_id, p_step_number, 'reserved', now() + v_lease
  )
  returning * into v_res;

  return jsonb_build_object(
    'ok', true,
    'code', 'reserved',
    'reservation_id', v_res.id,
    'recovered', false,
    'expires_at', v_res.expires_at
  );
end;
$$;

revoke all on function public.reserve_workflow_dispatch_v1(uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_workflow_dispatch_v1(uuid, integer, integer)
  to service_role;

create or replace function public.complete_workflow_dispatch_v1(
  p_reservation_id uuid,
  p_outcome text
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_res public.workflow_dispatch_reservations%rowtype;
begin
  if p_outcome not in ('sent', 'simulated', 'suppressed', 'failed') then
    raise exception 'invalid dispatch outcome';
  end if;

  select * into v_res from public.workflow_dispatch_reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'not_found');
  end if;
  if v_res.status in ('sent', 'simulated', 'suppressed') then
    return jsonb_build_object('ok', true, 'code', 'already_dispatched', 'reservation_id', v_res.id);
  end if;

  update public.workflow_dispatch_reservations
  set
    status = p_outcome::public.dispatch_reservation_status,
    outcome_at = now()
  where id = p_reservation_id
  returning * into v_res;

  return jsonb_build_object('ok', true, 'code', p_outcome, 'reservation_id', v_res.id);
end;
$$;

revoke all on function public.complete_workflow_dispatch_v1(uuid, text)
  from public, anon, authenticated;
grant execute on function public.complete_workflow_dispatch_v1(uuid, text)
  to service_role;
