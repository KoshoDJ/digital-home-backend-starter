'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  api,
  EmptyState,
  Field,
  fmtMoney,
  GhostBtn,
  leadName,
  Loading,
  Modal,
  PageHeader,
  PrimaryBtn,
  TextInput,
  useToast,
} from '@/components/crm/kit';

type Stage = { id: string; name: string; position: number };
type Pipeline = { id: string; name: string; is_default: boolean; stages: Stage[] };
type Opp = {
  id: string;
  name: string;
  stage_id: string;
  value_cents: number;
  status: 'open' | 'won' | 'lost';
  leads: { id: string; email: string; first_name: string | null; last_name: string | null; company: string | null } | null;
};

export default function PipelinePage() {
  const { show, node: toastNode } = useToast();
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [opps, setOpps] = useState<Opp[] | null>(null);
  const [dragging, setDragging] = useState<Opp | null>(null);
  const [addStage, setAddStage] = useState<Stage | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const load = useCallback(async () => {
    try {
      const { pipelines } = await api<{ pipelines: Pipeline[] }>('/api/crm/pipelines');
      const p = pipelines.find((x) => x.is_default) || pipelines[0];
      if (!p) {
        setPipeline(null);
        setOpps([]);
        return;
      }
      setPipeline(p);
      const res = await api<{ opportunities: Opp[] }>(`/api/crm/opportunities?pipeline_id=${p.id}`);
      setOpps(res.opportunities);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed to load pipeline', 'err');
      setOpps([]);
    }
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  const onDragStart = (e: DragStartEvent) => {
    setDragging(opps?.find((o) => o.id === e.active.id) || null);
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setDragging(null);
    const oppId = String(e.active.id);
    const stageId = e.over ? String(e.over.id) : null;
    if (!stageId || !opps) return;
    const opp = opps.find((o) => o.id === oppId);
    if (!opp || opp.stage_id === stageId) return;

    const prev = opps;
    setOpps(opps.map((o) => (o.id === oppId ? { ...o, stage_id: stageId } : o)));
    try {
      await api(`/api/crm/opportunities/${oppId}`, { method: 'PATCH', body: JSON.stringify({ stage_id: stageId }) });
    } catch (err) {
      setOpps(prev);
      show(err instanceof Error ? err.message : 'Move failed', 'err');
    }
  };

  const setStatus = async (opp: Opp, status: 'won' | 'lost' | 'open') => {
    try {
      await api(`/api/crm/opportunities/${opp.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      show(status === 'won' ? `Won: ${opp.name} 🎉` : status === 'lost' ? `Lost: ${opp.name}` : 'Reopened');
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Update failed', 'err');
    }
  };

  if (opps === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Pipeline" />
        <Loading />
      </div>
    );
  }

  const open = opps.filter((o) => o.status === 'open');
  const totalValue = open.reduce((s, o) => s + o.value_cents, 0);
  const won = opps.filter((o) => o.status === 'won');
  const wonValue = won.reduce((s, o) => s + o.value_cents, 0);

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title={`Pipeline · ${pipeline?.name || ''}`}>
        <span className="text-xs text-minimal-muted">
          {open.length} open · {fmtMoney(totalValue)} — {won.length} won · {fmtMoney(wonValue)}
        </span>
      </PageHeader>

      {!pipeline ? (
        <EmptyState title="No pipeline" hint="Run the CRM migration to seed the default Sales Pipeline." />
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden px-12 pb-8">
          <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
            <div className="flex gap-4 h-full min-w-max">
              {pipeline.stages.map((stage) => (
                <StageColumn
                  key={stage.id}
                  stage={stage}
                  opps={open.filter((o) => o.stage_id === stage.id)}
                  onAdd={() => setAddStage(stage)}
                  onStatus={setStatus}
                />
              ))}
            </div>
            <DragOverlay>
              {dragging && (
                <div className="w-64 border border-zinc-500 bg-minimal-row rounded-lg p-3.5 opacity-90">
                  <CardBody opp={dragging} />
                </div>
              )}
            </DragOverlay>
          </DndContext>
        </div>
      )}

      {addStage && pipeline && (
        <AddOppModal
          stage={addStage}
          onClose={() => setAddStage(null)}
          onDone={(msg, ok) => {
            setAddStage(null);
            show(msg, ok ? 'ok' : 'err');
            load();
          }}
        />
      )}
    </div>
  );
}

function StageColumn({
  stage,
  opps,
  onAdd,
  onStatus,
}: {
  stage: Stage;
  opps: Opp[];
  onAdd: () => void;
  onStatus: (opp: Opp, status: 'won' | 'lost' | 'open') => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });
  const value = opps.reduce((s, o) => s + o.value_cents, 0);

  return (
    <div
      ref={setNodeRef}
      className={`w-72 shrink-0 flex flex-col border rounded-lg transition-colors ${
        isOver ? 'drop-target-valid border-minimal-border' : 'border-minimal-border'
      }`}
    >
      <div className="px-4 py-3 border-b border-minimal-border flex items-center justify-between shrink-0">
        <span className="text-xs font-medium text-zinc-300">{stage.name}</span>
        <span className="text-xs text-zinc-600">
          {opps.length}
          {value > 0 ? ` · ${fmtMoney(value)}` : ''}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2.5">
        {opps.map((opp) => (
          <OppCard key={opp.id} opp={opp} onStatus={onStatus} />
        ))}
        <button
          onClick={onAdd}
          className="text-xs text-zinc-600 hover:text-white border border-dashed border-minimal-border hover:border-minimal-muted rounded-lg py-2.5 transition-colors"
        >
          + Add
        </button>
      </div>
    </div>
  );
}

function OppCard({ opp, onStatus }: { opp: Opp; onStatus: (opp: Opp, status: 'won' | 'lost' | 'open') => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: opp.id });
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={`group border border-minimal-border bg-minimal-row rounded-lg p-3.5 cursor-grab active:cursor-grabbing ${
        isDragging ? 'dragging-card' : ''
      }`}
    >
      <CardBody opp={opp} />
      <div className="flex items-center gap-2 mt-2.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatus(opp, 'won');
          }}
          className="text-xs text-green-500 hover:bg-green-500/10 border border-green-500/30 rounded-lg px-2 py-1"
        >
          Won
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onStatus(opp, 'lost');
          }}
          className="text-xs text-red-400 hover:bg-red-500/10 border border-red-500/30 rounded-lg px-2 py-1"
        >
          Lost
        </button>
        {opp.leads && (
          <Link
            href={`/crm/leads/${opp.leads.id}`}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            className="ml-auto text-xs text-zinc-500 hover:text-white"
          >
            Open →
          </Link>
        )}
      </div>
    </div>
  );
}

function CardBody({ opp }: { opp: Opp }) {
  return (
    <>
      <p className="text-sm text-white leading-snug">{opp.name}</p>
      <p className="text-xs text-zinc-600 mt-1 truncate">
        {opp.leads ? leadName(opp.leads) : '—'}
        {opp.leads?.company ? ` · ${opp.leads.company}` : ''}
      </p>
      {opp.value_cents > 0 && <p className="text-xs text-zinc-400 mt-1">{fmtMoney(opp.value_cents)}</p>}
    </>
  );
}

function AddOppModal({
  stage,
  onClose,
  onDone,
}: {
  stage: Stage;
  onClose: () => void;
  onDone: (msg: string, ok: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null }[]>([]);
  const [selected, setSelected] = useState<{ id: string; email: string; first_name: string | null; last_name: string | null } | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (term: string) => {
    setQ(term);
    setSelected(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (!term.trim()) return setResults([]);
      try {
        const res = await api<{ data: typeof results }>(`/api/crm/leads?q=${encodeURIComponent(term)}&limit=6`);
        setResults(res.data);
      } catch {
        setResults([]);
      }
    }, 250);
  };

  const create = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await api('/api/crm/opportunities', {
        method: 'POST',
        body: JSON.stringify({
          lead_id: selected.id,
          stage_id: stage.id,
          value_cents: Math.round(Number(value || 0) * 100),
        }),
      });
      onDone(`Added to ${stage.name}`, true);
    } catch (e) {
      onDone(e instanceof Error ? e.message : 'Failed', false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Add to "${stage.name}"`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Find lead">
          <TextInput autoFocus value={q} onChange={(e) => search(e.target.value)} placeholder="Search by email or name…" />
        </Field>
        {!selected && results.length > 0 && (
          <div className="border border-minimal-border rounded-lg divide-y divide-minimal-border max-h-48 overflow-y-auto">
            {results.map((r) => (
              <button
                key={r.id}
                onClick={() => {
                  setSelected(r);
                  setQ(leadName(r));
                }}
                className="w-full text-left px-4 py-2.5 hover:bg-minimal-row"
              >
                <span className="text-sm text-zinc-300">{leadName(r)}</span>
                <span className="text-xs text-zinc-600 ml-2">{r.email}</span>
              </button>
            ))}
          </div>
        )}
        <Field label="Deal value (AUD)" hint="Optional — shows on the board and dashboard totals">
          <TextInput type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="0" />
        </Field>
        <div className="flex justify-end gap-3">
          <GhostBtn onClick={onClose}>Cancel</GhostBtn>
          <PrimaryBtn onClick={create} disabled={!selected || busy}>
            {busy ? 'Adding…' : 'Add opportunity'}
          </PrimaryBtn>
        </div>
      </div>
    </Modal>
  );
}
