'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  api,
  Field,
  GhostBtn,
  leadName,
  Loading,
  Modal,
  PrimaryBtn,
  Select,
  TextArea,
  TextInput,
  timeAgo,
  useToast,
} from '@/components/crm/kit';

type Step = { id: string; type: string; config: Record<string, unknown> };
type Workflow = {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  steps: Step[];
  allow_reenrollment: boolean;
};
type Template = { id: string; name: string; subject: string; preheader: string | null; body_md: string };
type Enrollment = {
  id: string;
  status: string;
  current_step: number;
  next_run_at: string;
  last_error: string | null;
  leads: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
};
type Stage = { id: string; name: string };
type StepStat = { sent: number; opened: number; clicked: number };
type EmailStats = StepStat & { by_step: Record<number, StepStat> };

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

const STEP_LABELS: Record<string, string> = {
  send_email: 'Send email',
  wait: 'Wait',
  add_tag: 'Add tag',
  remove_tag: 'Remove tag',
  set_status: 'Set lead status',
  move_stage: 'Move pipeline stage',
  update_field: 'Update field',
  webhook: 'Call webhook',
  create_task: 'Create task',
};

const STEP_ICONS: Record<string, string> = {
  send_email: '✉',
  wait: '◷',
  add_tag: '#',
  remove_tag: '#',
  set_status: '⇄',
  move_stage: '⇢',
  update_field: '✎',
  webhook: '⚡',
  create_task: '☐',
};

let stepCounter = 0;
function newStepId(): string {
  stepCounter += 1;
  return `step-${Date.now()}-${stepCounter}`;
}

export default function WorkflowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { show, node: toastNode } = useToast();
  const [wf, setWf] = useState<Workflow | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [templates, setTemplates] = useState<Template[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [confirmDeleteStep, setConfirmDeleteStep] = useState<{ step: Step; index: number } | null>(null);
  const [emailStats, setEmailStats] = useState<EmailStats | null>(null);

  const load = useCallback(async () => {
    try {
      const [w, t, p] = await Promise.all([
        api<{
          workflow: Workflow;
          enrollments: Enrollment[];
          enrollment_counts: Record<string, number>;
          email_stats: EmailStats;
        }>(`/api/crm/workflows/${id}`),
        api<{ templates: Template[] }>('/api/crm/templates'),
        api<{ pipelines: { stages: Stage[] }[] }>('/api/crm/pipelines'),
      ]);
      setWf({ ...w.workflow, steps: (w.workflow.steps as Step[]) || [] });
      setEnrollments(w.enrollments);
      setCounts(w.enrollment_counts);
      setEmailStats(w.email_stats || null);
      setTemplates(t.templates);
      setStages(p.pipelines.flatMap((x) => x.stages));
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed to load', 'err');
    }
  }, [id, show]);

  useEffect(() => {
    load();
  }, [load]);

  const mutate = (updates: Partial<Workflow>) => {
    setWf((w) => (w ? { ...w, ...updates } : w));
    setDirty(true);
  };

  const save = async (extra?: Record<string, unknown>): Promise<boolean> => {
    if (!wf) return false;
    setSaving(true);
    try {
      const res = await api<{ workflow: Workflow }>(`/api/crm/workflows/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: wf.name,
          description: wf.description,
          trigger_type: wf.trigger_type,
          trigger_config: wf.trigger_config,
          steps: wf.steps,
          allow_reenrollment: wf.allow_reenrollment,
          ...extra,
        }),
      });
      setWf({ ...res.workflow, steps: (res.workflow.steps as Step[]) || [] });
      setDirty(false);
      return true;
    } catch (e) {
      show(e instanceof Error ? e.message : 'Save failed', 'err');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const setLive = async (next: 'active' | 'paused' | 'draft') => {
    const ok = await save({ status: next });
    if (ok) show(next === 'active' ? 'Workflow is LIVE — new matching leads will enroll' : `Workflow ${next}`);
  };

  const archive = async () => {
    try {
      await api(`/api/crm/workflows/${id}`, { method: 'DELETE' });
      window.location.href = '/crm/workflows';
    } catch (e) {
      show(e instanceof Error ? e.message : 'Archive failed', 'err');
    }
  };

  if (!wf) {
    return (
      <div className="flex flex-col h-full">
        <header className="h-20 px-12 flex items-center shrink-0">
          <Link href="/crm/workflows" className="text-xs text-minimal-muted hover:text-white">
            ← Workflows
          </Link>
        </header>
        <Loading />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <header className="h-20 px-12 flex items-center justify-between gap-6 shrink-0">
        <div className="flex items-center gap-5 min-w-0 flex-1">
          <Link href="/crm/workflows" className="text-xs text-minimal-muted hover:text-white shrink-0">
            ← Workflows
          </Link>
          <input
            value={wf.name}
            onChange={(e) => mutate({ name: e.target.value })}
            className="bg-transparent text-sm font-medium text-white outline-none border-b border-transparent focus:border-minimal-border flex-1 min-w-0"
          />
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className={`text-xs font-medium capitalize border rounded-lg px-2.5 py-1.5 ${
              wf.status === 'active'
                ? 'text-green-400 border-green-500/30'
                : wf.status === 'paused'
                  ? 'text-yellow-500 border-yellow-500/30'
                  : 'text-zinc-500 border-minimal-border'
            }`}
          >
            {wf.status}
          </span>
          {dirty && (
            <GhostBtn onClick={() => save()} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </GhostBtn>
          )}
          {wf.status === 'active' ? (
            <GhostBtn onClick={() => setLive('paused')}>Pause</GhostBtn>
          ) : (
            <PrimaryBtn onClick={() => setLive('active')} disabled={wf.steps.length === 0}>
              {wf.status === 'paused' ? 'Resume' : 'Activate'}
            </PrimaryBtn>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-12 pb-12">
        <div className="grid lg:grid-cols-3 gap-10">
          {/* Left: trigger + steps */}
          <div className="lg:col-span-2 flex flex-col gap-8">
            {/* Trigger */}
            <section className="border border-minimal-border rounded-lg p-6">
              <h3 className="text-[13px] font-semibold text-zinc-300 mb-4">
                Trigger — who enters this workflow
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <Field label="When">
                  <Select value={wf.trigger_type} onChange={(e) => mutate({ trigger_type: e.target.value, trigger_config: {} })}>
                    <option value="manual">Manual enrollment only</option>
                    <option value="lead_created">New lead is created</option>
                    <option value="form_submitted">A form is submitted</option>
                    <option value="tag_added">A tag is added</option>
                    <option value="status_changed">Lead status changes</option>
                    <option value="stage_changed">Pipeline stage changes</option>
                  </Select>
                </Field>
                {wf.trigger_type === 'tag_added' && (
                  <Field label="Tag (blank = any)">
                    <TextInput
                      value={String(wf.trigger_config.tag || '')}
                      onChange={(e) => mutate({ trigger_config: { ...wf.trigger_config, tag: e.target.value || undefined } })}
                    />
                  </Field>
                )}
                {wf.trigger_type === 'form_submitted' && (
                  <Field label="Form name (blank = any)">
                    <TextInput
                      value={String(wf.trigger_config.form || '')}
                      onChange={(e) => mutate({ trigger_config: { ...wf.trigger_config, form: e.target.value || undefined } })}
                      placeholder="newsletter"
                    />
                  </Field>
                )}
                {wf.trigger_type === 'status_changed' && (
                  <Field label="To status (blank = any)">
                    <Select
                      value={String(wf.trigger_config.status || '')}
                      onChange={(e) => mutate({ trigger_config: { ...wf.trigger_config, status: e.target.value || undefined } })}
                    >
                      <option value="">Any</option>
                      {['new', 'engaged', 'qualified', 'converted', 'lost'].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {wf.trigger_type === 'stage_changed' && (
                  <Field label="To stage (blank = any)">
                    <Select
                      value={String(wf.trigger_config.stage_id || '')}
                      onChange={(e) => mutate({ trigger_config: { ...wf.trigger_config, stage_id: e.target.value || undefined } })}
                    >
                      <option value="">Any</option>
                      {stages.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                )}
                {wf.trigger_type === 'lead_created' && (
                  <Field label="Source (blank = any)">
                    <TextInput
                      value={String(wf.trigger_config.source || '')}
                      onChange={(e) => mutate({ trigger_config: { ...wf.trigger_config, source: e.target.value || undefined } })}
                      placeholder="newsletter"
                    />
                  </Field>
                )}
              </div>
              <label className="flex items-center gap-2.5 mt-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={wf.allow_reenrollment}
                  onChange={(e) => mutate({ allow_reenrollment: e.target.checked })}
                />
                <span className="text-xs text-zinc-400">Allow leads to go through this workflow more than once</span>
              </label>
            </section>

            {/* Steps */}
            <section>
              <h3 className="text-[13px] font-semibold text-zinc-300 mb-4">Steps</h3>
              <div className="flex flex-col">
                {wf.steps.map((step, i) => (
                  <div key={step.id}>
                    <StepRow
                      step={step}
                      index={i}
                      total={wf.steps.length}
                      templates={templates}
                      stages={stages}
                      expanded={expanded === step.id}
                      onToggle={() => setExpanded(expanded === step.id ? null : step.id)}
                      stat={step.type === 'send_email' ? emailStats?.by_step?.[i] || null : null}
                      onChange={(s) => mutate({ steps: wf.steps.map((x) => (x.id === step.id ? s : x)) })}
                      onDelete={() => setConfirmDeleteStep({ step, index: i })}
                      onMove={(dir) => {
                        const steps = [...wf.steps];
                        const j = i + dir;
                        if (j < 0 || j >= steps.length) return;
                        [steps[i], steps[j]] = [steps[j], steps[i]];
                        mutate({ steps });
                      }}
                      onTemplateSaved={load}
                      onNotify={show}
                    />
                    <div className="flex justify-center py-1">
                      <span className="text-zinc-700 text-xs">↓</span>
                    </div>
                  </div>
                ))}
                <AddStepMenu
                  onAdd={(type) => {
                    const step: Step = { id: newStepId(), type, config: type === 'wait' ? { days: 2 } : {} };
                    mutate({ steps: [...wf.steps, step] });
                    setExpanded(step.id);
                  }}
                />
              </div>
            </section>

            {/* Danger zone */}
            <section className="flex justify-end">
              <GhostBtn danger onClick={() => setConfirmArchive(true)}>
                Archive workflow
              </GhostBtn>
            </section>
          </div>

          {/* Right: engagement + enrollments */}
          <div>
            <h3 className="text-[13px] font-semibold text-zinc-300 mb-4">Email engagement</h3>
            <div className="grid grid-cols-3 gap-px bg-minimal-border border border-minimal-border rounded-lg overflow-hidden mb-8">
              <div className="bg-minimal-bg px-3 py-3 text-center">
                <p className="text-lg font-semibold text-white">{emailStats?.sent ?? 0}</p>
                <p className="text-xs text-minimal-muted mt-0.5">delivered</p>
              </div>
              <div className="bg-minimal-bg px-3 py-3 text-center" title={`${emailStats?.opened ?? 0} opened`}>
                <p className="text-lg font-semibold text-white">{pct(emailStats?.opened ?? 0, emailStats?.sent ?? 0)}</p>
                <p className="text-xs text-minimal-muted mt-0.5">open rate</p>
              </div>
              <div className="bg-minimal-bg px-3 py-3 text-center" title={`${emailStats?.clicked ?? 0} clicked`}>
                <p className="text-lg font-semibold text-white">{pct(emailStats?.clicked ?? 0, emailStats?.sent ?? 0)}</p>
                <p className="text-xs text-minimal-muted mt-0.5">click rate</p>
              </div>
            </div>

            <h3 className="text-[13px] font-semibold text-zinc-300 mb-4">Enrollments</h3>
            <div className="grid grid-cols-4 gap-px bg-minimal-border border border-minimal-border rounded-lg overflow-hidden mb-5">
              {(['active', 'completed', 'exited', 'failed'] as const).map((k) => (
                <div key={k} className="bg-minimal-bg px-3 py-3 text-center">
                  <p className="text-lg font-semibold text-white">{counts[k] || 0}</p>
                  <p className="text-xs capitalize text-minimal-muted mt-0.5">{k}</p>
                </div>
              ))}
            </div>
            {enrollments.length === 0 ? (
              <p className="text-[13px] text-zinc-600 leading-relaxed">
                No one enrolled yet. Activate the workflow and matching leads enroll automatically — or enroll people
                from their lead page.
              </p>
            ) : (
              <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border">
                {enrollments.slice(0, 20).map((en) => (
                  <Link key={en.id} href={`/crm/leads/${en.leads?.id}`} className="block px-4 py-3 hover:bg-minimal-row">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[13px] text-zinc-300 truncate">{en.leads ? leadName(en.leads) : '—'}</span>
                      <span
                        className={`text-xs font-medium capitalize shrink-0 ${
                          en.status === 'active' ? 'text-green-400' : en.status === 'failed' ? 'text-red-400' : 'text-zinc-500'
                        }`}
                      >
                        {en.status}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-600 mt-0.5">
                      step {en.current_step + 1}/{wf.steps.length || '?'}
                      {en.status === 'active' ? ` · next ${timeAgo(en.next_run_at).replace(' ago', '')}` : ''}
                      {en.last_error ? ` · ${en.last_error.slice(0, 60)}` : ''}
                    </p>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {confirmDeleteStep && (
        <Modal title={`Delete step ${confirmDeleteStep.index + 1}?`} onClose={() => setConfirmDeleteStep(null)}>
          <p className="text-sm text-zinc-400 leading-relaxed mb-2">
            <span className="text-zinc-300">
              {STEP_LABELS[confirmDeleteStep.step.type] || confirmDeleteStep.step.type}
            </span>
            {' — '}
            {stepSummary(confirmDeleteStep.step, templates, stages)}
          </p>
          <p className="text-[13px] text-zinc-500 leading-relaxed mb-6">
            {confirmDeleteStep.step.type === 'send_email' && !confirmDeleteStep.step.config.template_id
              ? 'This email is written inline on the step — deleting it loses the copy for good once you save.'
              : 'The step is removed once you hit Save changes.'}
          </p>
          <div className="flex justify-end gap-3">
            <GhostBtn onClick={() => setConfirmDeleteStep(null)}>Cancel</GhostBtn>
            <GhostBtn
              danger
              onClick={() => {
                mutate({ steps: wf.steps.filter((x) => x.id !== confirmDeleteStep.step.id) });
                setConfirmDeleteStep(null);
              }}
            >
              Delete step
            </GhostBtn>
          </div>
        </Modal>
      )}

      {confirmArchive && (
        <Modal title="Archive workflow?" onClose={() => setConfirmArchive(false)}>
          <p className="text-sm text-zinc-400 leading-relaxed mb-6">
            Archiving stops the workflow and exits everyone currently in it. Their history stays on their timelines.
          </p>
          <div className="flex justify-end gap-3">
            <GhostBtn onClick={() => setConfirmArchive(false)}>Cancel</GhostBtn>
            <GhostBtn danger onClick={archive}>
              Archive
            </GhostBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Step row ─────────────────────────────────────────────────────────────────

function stepSummary(step: Step, templates: Template[], stages: Stage[]): string {
  const c = step.config || {};
  switch (step.type) {
    case 'send_email': {
      if (c.template_id) {
        const t = templates.find((x) => x.id === c.template_id);
        return t ? `"${t.subject}"` : 'Template missing!';
      }
      return c.subject ? `"${c.subject}" (inline)` : 'Not configured';
    }
    case 'wait': {
      const parts = [];
      if (Number(c.days)) parts.push(`${c.days}d`);
      if (Number(c.hours)) parts.push(`${c.hours}h`);
      if (Number(c.minutes)) parts.push(`${c.minutes}m`);
      return parts.length ? parts.join(' ') : 'Not configured';
    }
    case 'add_tag':
    case 'remove_tag':
      return c.tag ? `"${c.tag}"` : 'Not configured';
    case 'set_status':
      return String(c.status || 'Not configured');
    case 'move_stage':
      return stages.find((s) => s.id === c.stage_id)?.name || 'Not configured';
    case 'update_field':
      return c.key ? `${c.key} = ${c.value}` : 'Not configured';
    case 'webhook':
      return String(c.url || 'Not configured');
    case 'create_task':
      return String(c.title || 'Not configured');
    default:
      return '';
  }
}

function StepRow({
  step,
  index,
  total,
  templates,
  stages,
  stat,
  expanded,
  onToggle,
  onChange,
  onDelete,
  onMove,
  onTemplateSaved,
  onNotify,
}: {
  step: Step;
  index: number;
  total: number;
  templates: Template[];
  stages: Stage[];
  stat: StepStat | null;
  expanded: boolean;
  onToggle: () => void;
  onChange: (s: Step) => void;
  onDelete: () => void;
  onMove: (dir: -1 | 1) => void;
  onTemplateSaved: () => void;
  onNotify: (m: string, kind?: 'ok' | 'err') => void;
}) {
  const setCfg = (patch: Record<string, unknown>) => onChange({ ...step, config: { ...step.config, ...patch } });

  return (
    <div className={`border rounded-lg ${expanded ? 'border-zinc-600' : 'border-minimal-border'} bg-minimal-row`}>
      <div className="flex items-center gap-4 px-4 py-3 cursor-pointer select-none" onClick={onToggle}>
        <span className="text-minimal-muted w-4 text-center">{STEP_ICONS[step.type] || '·'}</span>
        <span className="text-xs text-zinc-500 w-32 shrink-0">
          {index + 1}. {STEP_LABELS[step.type] || step.type}
        </span>
        <span className="text-[13px] text-zinc-400 truncate flex-1">{stepSummary(step, templates, stages)}</span>
        {stat && stat.sent > 0 && (
          <span
            className="text-xs text-zinc-500 shrink-0"
            title={`${stat.sent} delivered · ${stat.opened} opened · ${stat.clicked} clicked`}
          >
            {stat.sent} sent · {pct(stat.opened, stat.sent)} open · {pct(stat.clicked, stat.sent)} click
          </span>
        )}
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button onClick={() => onMove(-1)} disabled={index === 0} className="text-zinc-600 hover:text-white disabled:opacity-20 px-1">
            ↑
          </button>
          <button onClick={() => onMove(1)} disabled={index === total - 1} className="text-zinc-600 hover:text-white disabled:opacity-20 px-1">
            ↓
          </button>
          <button onClick={onDelete} className="text-zinc-600 hover:text-red-400 px-1">
            ×
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-minimal-border p-4">
          {step.type === 'send_email' && (
            <EmailStepEditor step={step} templates={templates} setCfg={setCfg} onTemplateSaved={onTemplateSaved} onNotify={onNotify} />
          )}
          {step.type === 'wait' && (
            <div className="grid grid-cols-3 gap-3 max-w-sm">
              {(['days', 'hours', 'minutes'] as const).map((unit) => (
                <Field key={unit} label={unit}>
                  <TextInput
                    type="number"
                    min={0}
                    value={String(step.config[unit] ?? '')}
                    onChange={(e) => setCfg({ [unit]: Number(e.target.value) || 0 })}
                  />
                </Field>
              ))}
            </div>
          )}
          {(step.type === 'add_tag' || step.type === 'remove_tag') && (
            <Field label="Tag">
              <TextInput value={String(step.config.tag || '')} onChange={(e) => setCfg({ tag: e.target.value })} />
            </Field>
          )}
          {step.type === 'set_status' && (
            <Field label="Status">
              <Select value={String(step.config.status || '')} onChange={(e) => setCfg({ status: e.target.value })}>
                <option value="">Choose…</option>
                {['new', 'engaged', 'qualified', 'converted', 'lost'].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {step.type === 'move_stage' && (
            <Field label="Stage" hint="Creates an opportunity if the lead has none">
              <Select value={String(step.config.stage_id || '')} onChange={(e) => setCfg({ stage_id: e.target.value })}>
                <option value="">Choose…</option>
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {step.type === 'update_field' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Field key" hint="first_name, company, score… or custom.your_field">
                <TextInput value={String(step.config.key || '')} onChange={(e) => setCfg({ key: e.target.value })} />
              </Field>
              <Field label="Value">
                <TextInput value={String(step.config.value ?? '')} onChange={(e) => setCfg({ value: e.target.value })} />
              </Field>
            </div>
          )}
          {step.type === 'webhook' && (
            <Field label="URL" hint="POSTs a JSON payload with the lead — connect Zapier/Make/n8n or your own agent">
              <TextInput value={String(step.config.url || '')} onChange={(e) => setCfg({ url: e.target.value })} placeholder="https://…" />
            </Field>
          )}
          {step.type === 'create_task' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Task title" hint="Merge tags work, e.g. Call {{first_name}}">
                <TextInput value={String(step.config.title || '')} onChange={(e) => setCfg({ title: e.target.value })} />
              </Field>
              <Field label="Due in (days)">
                <TextInput
                  type="number"
                  min={0}
                  value={String(step.config.due_in_days ?? '')}
                  onChange={(e) => setCfg({ due_in_days: Number(e.target.value) || 0 })}
                />
              </Field>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Email step editor (template edit + preview + AI rewrite) ────────────────

function EmailStepEditor({
  step,
  templates,
  setCfg,
  onTemplateSaved,
  onNotify,
}: {
  step: Step;
  templates: Template[];
  setCfg: (patch: Record<string, unknown>) => void;
  onTemplateSaved: () => void;
  onNotify: (m: string, kind?: 'ok' | 'err') => void;
}) {
  const templateId = step.config.template_id as string | undefined;
  const template = templates.find((t) => t.id === templateId);
  const [subject, setSubject] = useState(template?.subject ?? String(step.config.subject || ''));
  const [preheader, setPreheader] = useState(template?.preheader ?? String(step.config.preheader || ''));
  const [bodyMd, setBodyMd] = useState(template?.body_md ?? String(step.config.body_md || ''));
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [aiInstruction, setAiInstruction] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [savingTpl, setSavingTpl] = useState(false);
  const [testTo, setTestTo] = useState('');

  useEffect(() => {
    if (template) {
      setSubject(template.subject);
      setPreheader(template.preheader || '');
      setBodyMd(template.body_md);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId, templates.length]);

  const persist = async () => {
    if (templateId) {
      setSavingTpl(true);
      try {
        await api(`/api/crm/templates/${templateId}`, {
          method: 'PATCH',
          body: JSON.stringify({ subject, preheader: preheader || null, body_md: bodyMd }),
        });
        onNotify('Email saved');
        onTemplateSaved();
      } catch (e) {
        onNotify(e instanceof Error ? e.message : 'Save failed', 'err');
      } finally {
        setSavingTpl(false);
      }
    } else {
      setCfg({ subject, preheader: preheader || undefined, body_md: bodyMd });
      onNotify('Email saved to step — remember to Save changes');
    }
  };

  const preview = async () => {
    if (templateId) {
      try {
        const res = await api<{ preview_html: string }>(`/api/crm/templates/${templateId}`);
        setPreviewHtml(res.preview_html);
      } catch (e) {
        onNotify(e instanceof Error ? e.message : 'Preview failed', 'err');
      }
    }
  };

  const aiRewrite = async () => {
    if (!aiInstruction.trim()) return;
    setAiBusy(true);
    try {
      const res = await api<{ rewrite: { subject: string; preheader: string; body_md: string } }>(
        '/api/crm/ai/rewrite-email',
        {
          method: 'POST',
          body: JSON.stringify({
            template_id: templateId,
            subject,
            preheader,
            body_md: bodyMd,
            instruction: aiInstruction,
            apply: !!templateId,
          }),
        }
      );
      setSubject(res.rewrite.subject);
      setPreheader(res.rewrite.preheader || '');
      setBodyMd(res.rewrite.body_md);
      setAiInstruction('');
      onNotify(templateId ? 'Rewritten + saved' : 'Rewritten — review and save');
      if (templateId) onTemplateSaved();
    } catch (e) {
      onNotify(e instanceof Error ? e.message : 'AI rewrite failed', 'err');
    } finally {
      setAiBusy(false);
    }
  };

  const sendTest = async () => {
    if (!templateId || !testTo.trim()) return;
    try {
      const res = await api<{ sent: boolean; preview_only?: boolean; note?: string }>(
        `/api/crm/templates/${templateId}/test`,
        { method: 'POST', body: JSON.stringify({ to: testTo.trim() }) }
      );
      onNotify(res.sent ? `Test sent to ${testTo}` : res.note || 'No email provider configured yet', res.sent ? 'ok' : 'err');
    } catch (e) {
      onNotify(e instanceof Error ? e.message : 'Test failed', 'err');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Field label="Template">
            <Select
              value={templateId || ''}
              onChange={(e) => setCfg({ template_id: e.target.value || undefined })}
            >
              <option value="">— Write inline (stored on the step) —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Subject">
          <TextInput value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="Preheader">
          <TextInput value={preheader} onChange={(e) => setPreheader(e.target.value)} />
        </Field>
      </div>
      <Field label="Body (markdown)" hint="Merge tags: {{first_name|there}} {{company}} {{custom.field}} — a paragraph that is just a link becomes a button">
        <TextArea rows={10} value={bodyMd} onChange={(e) => setBodyMd(e.target.value)} className="font-mono text-[13px]" />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <GhostBtn onClick={persist} disabled={savingTpl}>
          {savingTpl ? 'Saving…' : 'Save email'}
        </GhostBtn>
        {templateId && <GhostBtn onClick={preview}>Preview</GhostBtn>}
        {templateId && (
          <div className="flex items-center gap-2">
            <TextInput
              placeholder="you@yourdomain.com"
              value={testTo}
              onChange={(e) => setTestTo(e.target.value)}
              className="w-52"
            />
            <GhostBtn onClick={sendTest} disabled={!testTo.trim()}>
              Send test
            </GhostBtn>
          </div>
        )}
      </div>

      {/* AI rewrite bar */}
      <div className="border border-emerald-500/20 bg-emerald-500/5 rounded-lg p-3 flex items-center gap-3">
        <span className="text-emerald-500 text-xs shrink-0">✦</span>
        <input
          value={aiInstruction}
          onChange={(e) => setAiInstruction(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && aiRewrite()}
          placeholder='Tell the AI how to change it… "shorter and punchier", "lead with the case study", "make the CTA about the workshop"'
          className="flex-1 bg-transparent text-[13px] text-zinc-300 placeholder:text-zinc-600 outline-none"
        />
        <button
          onClick={aiRewrite}
          disabled={aiBusy || !aiInstruction.trim()}
          className="text-xs text-emerald-400 hover:text-emerald-300 disabled:opacity-40 shrink-0"
        >
          {aiBusy ? 'Rewriting…' : 'Rewrite'}
        </button>
      </div>

      {previewHtml && (
        <Modal title={subject || 'Preview'} onClose={() => setPreviewHtml(null)} wide>
          <iframe srcDoc={previewHtml} className="w-full h-[60vh] bg-white rounded-lg" title="Email preview" />
        </Modal>
      )}
    </div>
  );
}

// ── Add step menu ────────────────────────────────────────────────────────────

function AddStepMenu({ onAdd }: { onAdd: (type: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-xs text-zinc-500 hover:text-white border border-dashed border-minimal-border hover:border-minimal-muted rounded-lg py-3 transition-colors"
      >
        + Add step
      </button>
      {open && (
        <div className="absolute z-20 mt-2 left-0 right-0 border border-minimal-border bg-minimal-bg rounded-lg grid grid-cols-3 divide-x divide-y divide-minimal-border overflow-hidden">
          {Object.entries(STEP_LABELS).map(([type, label]) => (
            <button
              key={type}
              onClick={() => {
                onAdd(type);
                setOpen(false);
              }}
              className="px-4 py-3 text-left hover:bg-minimal-row transition-colors"
            >
              <span className="text-minimal-muted mr-2">{STEP_ICONS[type]}</span>
              <span className="text-xs text-zinc-300">{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
