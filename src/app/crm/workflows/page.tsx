'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { WritingGlow } from '@/components/ui/writing-glow';
import {
  api,
  EmptyState,
  Field,
  GhostBtn,
  Loading,
  Modal,
  PageHeader,
  PrimaryBtn,
  Select,
  TextArea,
  TextInput,
  timeAgo,
  useToast,
} from '@/components/crm/kit';

type Workflow = {
  id: string;
  name: string;
  description: string | null;
  status: 'draft' | 'active' | 'paused' | 'archived';
  trigger_type: string;
  trigger_config: Record<string, unknown>;
  step_count: number;
  active_enrollments: number;
  enrolled_count: number;
  completed_count: number;
  email_stats: { sent: number; opened: number; clicked: number };
  ai_brief: unknown;
  updated_at: string;
};

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

const STATUS_COLORS: Record<string, string> = {
  draft: 'text-zinc-500 border-minimal-border',
  active: 'text-green-400 border-green-500/30',
  paused: 'text-yellow-500 border-yellow-500/30',
};

const TRIGGER_LABELS: Record<string, string> = {
  manual: 'Manual enrollment',
  lead_created: 'New lead created',
  form_submitted: 'Form submitted',
  tag_added: 'Tag added',
  status_changed: 'Status changed',
  stage_changed: 'Pipeline stage changed',
};

function triggerSummary(w: Workflow): string {
  const base = TRIGGER_LABELS[w.trigger_type] || w.trigger_type;
  const cfg = w.trigger_config || {};
  const detail = (cfg.tag || cfg.form || cfg.status || cfg.source) as string | undefined;
  return detail ? `${base}: ${detail}` : base;
}

export default function WorkflowsPage() {
  const router = useRouter();
  const { show, node: toastNode } = useToast();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [showAi, setShowAi] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await api<{ workflows: Workflow[] }>('/api/crm/workflows');
      setWorkflows(res.workflows);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed to load', 'err');
      setWorkflows([]);
    }
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  const createBlank = async () => {
    setCreating(true);
    try {
      const res = await api<{ workflow: { id: string } }>('/api/crm/workflows', {
        method: 'POST',
        body: JSON.stringify({ name: 'Untitled workflow' }),
      });
      router.push(`/crm/workflows/${res.workflow.id}`);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Create failed', 'err');
      setCreating(false);
    }
  };

  const toggleStatus = async (w: Workflow) => {
    const next = w.status === 'active' ? 'paused' : 'active';
    try {
      await api(`/api/crm/workflows/${w.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      show(next === 'active' ? `${w.name} is live` : `${w.name} paused`);
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Update failed', 'err');
    }
  };

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="Email · Workflows">
        <GhostBtn onClick={createBlank} disabled={creating}>
          {creating ? 'Creating…' : 'New blank'}
        </GhostBtn>
        <PrimaryBtn onClick={() => setShowAi(true)}>✦ Draft with AI</PrimaryBtn>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-12 pb-12">
        {workflows === null ? (
          <Loading />
        ) : workflows.length === 0 ? (
          <EmptyState
            title="No workflows yet"
            hint='Hit "Draft with AI" and brief it like a copywriter: who the sequence is for, what it should teach, and which offer it leads to. You review everything before it goes live.'
          />
        ) : (
          <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border">
            {workflows.map((w) => (
              <div key={w.id} className="flex items-center gap-6 px-6 py-4 hover:bg-minimal-row transition-colors group">
                <button
                  onClick={() => toggleStatus(w)}
                  title={w.status === 'active' ? 'Pause' : 'Activate'}
                  className={`shrink-0 text-xs font-medium capitalize border rounded-lg px-2.5 py-1.5 transition-colors ${STATUS_COLORS[w.status] || STATUS_COLORS.draft} hover:border-zinc-400`}
                >
                  {w.status}
                </button>
                <Link href={`/crm/workflows/${w.id}`} className="flex-1 min-w-0">
                  <p className="text-[14px] text-white truncate">
                    {w.name}
                    {w.ai_brief != null && <span className="ml-2 text-xs text-emerald-500/80">AI</span>}
                  </p>
                  <p className="text-xs text-zinc-600 mt-0.5 truncate">
                    {triggerSummary(w)} · {w.step_count} steps
                    {w.description ? ` · ${w.description}` : ''}
                  </p>
                </Link>
                <div
                  className="shrink-0 text-right w-44"
                  title={
                    w.email_stats.sent > 0
                      ? `${w.email_stats.sent} delivered · ${w.email_stats.opened} opened · ${w.email_stats.clicked} clicked`
                      : 'No emails delivered yet'
                  }
                >
                  <p className="text-[13px] text-zinc-400">
                    {w.email_stats.sent} sent · {pct(w.email_stats.opened, w.email_stats.sent)} open ·{' '}
                    {pct(w.email_stats.clicked, w.email_stats.sent)} click
                  </p>
                  <p className="text-xs text-zinc-600 mt-0.5">
                    {w.active_enrollments} active · {w.completed_count} completed
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {showAi && (
        <AiComposerModal
          onClose={() => setShowAi(false)}
          onDone={(id) => router.push(`/crm/workflows/${id}`)}
          onError={(m) => show(m, 'err')}
        />
      )}
    </div>
  );
}

function AiComposerModal({
  onClose,
  onDone,
  onError,
}: {
  onClose: () => void;
  onDone: (workflowId: string) => void;
  onError: (m: string) => void;
}) {
  const [brief, setBrief] = useState('');
  const [numEmails, setNumEmails] = useState('5');
  const [offerSlug, setOfferSlug] = useState('');
  const [trigger, setTrigger] = useState('manual');
  const [triggerDetail, setTriggerDetail] = useState('');
  const [drafting, setDrafting] = useState(false);

  const run = async () => {
    setDrafting(true);
    try {
      const trigger_config: Record<string, string> = {};
      if (trigger === 'tag_added' && triggerDetail.trim()) trigger_config.tag = triggerDetail.trim();
      if (trigger === 'form_submitted' && triggerDetail.trim()) trigger_config.form = triggerDetail.trim();

      const res = await api<{ workflow: { id: string } }>('/api/crm/ai/draft-sequence', {
        method: 'POST',
        body: JSON.stringify({
          brief,
          num_emails: Number(numEmails),
          offer_slug: offerSlug.trim() || undefined,
          trigger_type: trigger,
          trigger_config,
        }),
      });
      onDone(res.workflow.id);
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Draft failed');
      setDrafting(false);
    }
  };

  return (
    <Modal title="Brief the AI" onClose={onClose} wide>
      {drafting ? (
        <div className="relative rounded-lg border border-minimal-border">
          <WritingGlow />
          <div className="p-10 text-center">
            <p className="text-sm text-zinc-300">Writing your sequence…</p>
            <p className="text-xs text-zinc-600 mt-2 leading-relaxed">
              Reading your brand brain, studying your offers, drafting every email in your voice.
              <br />
              Usually 30–60 seconds. It lands as a DRAFT for your review.
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Field
            label="The brief"
            hint="Talk to it like a senior copywriter. Who is this for, where did they come from, what should they believe by the end, and what's the call to action?"
          >
            <TextArea
              autoFocus
              rows={6}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={
                'e.g. New leads from the newsletter signup on /learn. They\'re founders curious about AI systems but skeptical of hype. Warm them up over ~2 weeks: deliver a quick win with our content, shift them from "AI is a toy" to "AI is leverage", then invite them to book a discovery call. Keep it personal, no corporate voice.'
              }
            />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Emails">
              <Select value={numEmails} onChange={(e) => setNumEmails(e.target.value)}>
                {['3', '4', '5', '6', '7'].map((n) => (
                  <option key={n} value={n}>
                    {n} emails
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Anchor offer (slug)" hint="Optional">
              <TextInput value={offerSlug} onChange={(e) => setOfferSlug(e.target.value)} placeholder="e.g. brave-systems" />
            </Field>
            <Field label="Trigger">
              <Select value={trigger} onChange={(e) => setTrigger(e.target.value)}>
                <option value="manual">Manual (I&apos;ll enroll)</option>
                <option value="lead_created">Every new lead</option>
                <option value="form_submitted">Form submitted</option>
                <option value="tag_added">Tag added</option>
              </Select>
            </Field>
          </div>
          {(trigger === 'tag_added' || trigger === 'form_submitted') && (
            <Field label={trigger === 'tag_added' ? 'Which tag' : 'Which form'} hint="Leave blank to match any">
              <TextInput
                value={triggerDetail}
                onChange={(e) => setTriggerDetail(e.target.value)}
                placeholder={trigger === 'tag_added' ? 'e.g. newsletter' : 'e.g. newsletter'}
              />
            </Field>
          )}
          <div className="flex justify-end gap-3 mt-2">
            <GhostBtn onClick={onClose}>Cancel</GhostBtn>
            <PrimaryBtn onClick={run} disabled={brief.trim().length < 10}>
              Draft sequence
            </PrimaryBtn>
          </div>
        </div>
      )}
    </Modal>
  );
}
