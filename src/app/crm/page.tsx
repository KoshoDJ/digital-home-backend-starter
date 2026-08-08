'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  api,
  ACTIVITY_ICONS,
  EmptyState,
  fmtMoney,
  GhostBtn,
  leadName,
  Loading,
  PageHeader,
  timeAgo,
  useToast,
} from '@/components/crm/kit';

type Dashboard = {
  counts: {
    total_leads: number;
    new_this_week: number;
    active_enrollments: number;
    emails_7d: number;
    open_tasks: number;
    open_opportunities: number;
    pipeline_value_cents: number;
    won_total_cents: number;
    won_this_month_cents: number;
    won_deals: number;
  };
  upcoming_appointments: {
    id: string;
    title: string;
    starts_at: string;
    leads: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
  }[];
  recent_activities: {
    id: string;
    lead_id: string;
    activity_type: string;
    title: string;
    actor: string;
    created_at: string;
    leads: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
  }[];
};

type Task = {
  id: string;
  title: string;
  due_at: string | null;
  leads: { id: string; email: string; first_name: string | null; last_name: string | null } | null;
};

export default function CrmDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [ticking, setTicking] = useState(false);
  const { show, node: toastNode } = useToast();

  const load = useCallback(async () => {
    try {
      const [dash, taskRes] = await Promise.all([
        api<Dashboard>('/api/crm/dashboard'),
        api<{ tasks: Task[] }>('/api/crm/tasks?status=open'),
      ]);
      setData(dash);
      setTasks(taskRes.tasks.slice(0, 8));
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed to load', 'err');
    }
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  const runTick = async () => {
    setTicking(true);
    try {
      const result = await api<{ due: number; emails_sent: number; emails_simulated: number; completed: number }>(
        '/api/crm/tick',
        { method: 'POST', body: '{}' }
      );
      show(
        `Engine ran: ${result.due} due, ${result.emails_sent} sent, ${result.emails_simulated} simulated, ${result.completed} completed`
      );
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Tick failed', 'err');
    } finally {
      setTicking(false);
    }
  };

  const completeTask = async (id: string) => {
    try {
      await api(`/api/crm/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
      setTasks((t) => t.filter((task) => task.id !== id));
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed', 'err');
    }
  };

  if (!data) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="CRM" />
        <Loading />
      </div>
    );
  }

  const c = data.counts;
  const stats: { label: string; value: string; href?: string }[] = [
    { label: 'Leads', value: String(c.total_leads), href: '/crm/leads' },
    { label: 'New this week', value: String(c.new_this_week) },
    { label: 'In workflows', value: String(c.active_enrollments), href: '/crm/workflows' },
    { label: 'Emails · 7d', value: String(c.emails_7d) },
    // Money made: deals the CRM closed.
    {
      label: 'Won by CRM',
      value: `${fmtMoney(c.won_total_cents)}${c.won_this_month_cents ? ` · ${fmtMoney(c.won_this_month_cents)} this mo` : ''}`,
      href: '/crm/pipeline',
    },
    { label: 'Open tasks', value: String(c.open_tasks) },
  ];

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="CRM">
        <GhostBtn onClick={runTick} disabled={ticking}>
          {ticking ? 'Running…' : 'Run engine now'}
        </GhostBtn>
      </PageHeader>

      <div className="flex-1 overflow-y-auto px-12 pb-12">
        {/* Stat tiles */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-px bg-minimal-border border border-minimal-border rounded-lg overflow-hidden mb-10">
          {stats.map((s) => {
            const inner = (
              <div className="bg-minimal-bg hover:bg-minimal-row transition-colors px-5 py-6 h-full">
                <p className="text-2xl font-semibold text-white">{s.value}</p>
                <p className="text-xs text-minimal-muted mt-1.5">{s.label}</p>
              </div>
            );
            return s.href ? (
              <Link key={s.label} href={s.href}>
                {inner}
              </Link>
            ) : (
              <div key={s.label}>{inner}</div>
            );
          })}
        </div>

        <div className="grid lg:grid-cols-3 gap-10">
          {/* Activity feed */}
          <div className="lg:col-span-2">
            <h2 className="text-[13px] font-semibold text-zinc-300 mb-4">
              Latest activity
            </h2>
            {data.recent_activities.length === 0 ? (
              <EmptyState
                title="No activity yet"
                hint="Activity appears here the moment your first lead flows in — form fills, emails, tags, stage moves, everything."
              />
            ) : (
              <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border">
                {data.recent_activities.map((a) => (
                  <Link
                    key={a.id}
                    href={`/crm/leads/${a.lead_id}`}
                    className="flex items-center gap-4 px-5 py-3.5 hover:bg-minimal-row transition-colors group"
                  >
                    <span className="text-minimal-muted w-4 text-center shrink-0">
                      {ACTIVITY_ICONS[a.activity_type] || '·'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-300 truncate">{a.title}</p>
                      <p className="text-xs text-zinc-600 mt-0.5">
                        {a.leads ? leadName(a.leads) : 'Unknown lead'}
                        {a.actor.startsWith('agent:') || a.actor === 'system' ? ' · auto' : ''}
                      </p>
                    </div>
                    <span className="text-xs text-zinc-600 shrink-0">{timeAgo(a.created_at)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Tasks + appointments */}
          <div className="flex flex-col gap-10">
            <div>
              <h2 className="text-[13px] font-semibold text-zinc-300 mb-4">
                Open tasks
              </h2>
              {tasks.length === 0 ? (
                <p className="text-[13px] text-zinc-600">Nothing open. Workflows can create tasks for you.</p>
              ) : (
                <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border">
                  {tasks.map((t) => (
                    <div key={t.id} className="flex items-start gap-3 px-4 py-3 group">
                      <button
                        onClick={() => completeTask(t.id)}
                        title="Mark done"
                        className="w-4 h-4 mt-0.5 border border-minimal-border rounded-lg shrink-0 hover:border-green-500 hover:bg-green-500/20 transition-colors"
                      />
                      <div className="min-w-0">
                        <p className="text-sm text-zinc-300 leading-snug">{t.title}</p>
                        <p className="text-xs text-zinc-600 mt-0.5">
                          {t.leads ? leadName(t.leads) : ''}
                          {t.due_at ? ` · due ${timeAgo(t.due_at).replace(' ago', '')}` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <h2 className="text-[13px] font-semibold text-zinc-300 mb-4">
                Upcoming appointments
              </h2>
              {data.upcoming_appointments.length === 0 ? (
                <p className="text-[13px] text-zinc-600">No appointments scheduled.</p>
              ) : (
                <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border">
                  {data.upcoming_appointments.map((appt) => (
                    <div key={appt.id} className="px-4 py-3">
                      <p className="text-sm text-zinc-300">{appt.title}</p>
                      <p className="text-xs text-zinc-600 mt-0.5">
                        {appt.leads ? leadName(appt.leads) : ''} ·{' '}
                        {new Date(appt.starts_at).toLocaleString(undefined, {
                          weekday: 'short',
                          day: 'numeric',
                          month: 'short',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
