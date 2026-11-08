import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { fakeDb, type FakeDb } from "../money/fake-db.ts";
import type { AdminClient, CrmSettings, Enrollment, Lead, Workflow, WorkflowStep } from "./types.ts";
import type { TickSummary } from "./engine.ts";
import type { DispatchOutcome } from "./dispatch-reservation.ts";

const admin = (db: FakeDb) => db as unknown as AdminClient;
const LEAD = "11111111-1111-4111-8111-111111111111";
const WORKFLOW = "22222222-2222-4222-8222-222222222222";
const ENROLLMENT = "33333333-3333-4333-8333-333333333333";

function moduleUnderTest<T>(file: string, dependencies: Record<string, unknown>, expose = ""): T {
  const source = readFileSync(new URL(file, import.meta.url), "utf8") + expose;
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", js)(
    (id: string) => {
      if (!(id in dependencies)) throw new Error(`Unmocked dependency: ${id}`);
      return dependencies[id];
    },
    loaded,
    loaded.exports
  );
  return loaded.exports as T;
}

const settings: CrmSettings = {
  safe_mode: true,
  sender: { from_name: "Test Home", from_email: "hello@example.com" },
  send_window: { enabled: false, start_hour: 9, end_hour: 17, timezone: "UTC", days: [] },
  send_budget: {
    enabled: false,
    daily_limit: 100,
    per_tick_limit: 100,
    max_bounce_rate: 0.1,
    max_complaint_rate: 0.1,
    breaker_min_sends: 10,
    exempt_workflow_ids: [],
    suppress_tags: [],
  },
  capture_key: null,
  funnel_secret: null,
};

function emptySummary(): TickSummary {
  return {
    due: 0,
    completed: 0,
    emails_sent: 0,
    emails_simulated: 0,
    emails_suppressed: 0,
    emails_deferred_budget: 0,
    emails_deferred_quota: 0,
    emails_exempt: 0,
    skipped_locked: 0,
    health_alerts: [],
    budget_remaining: null,
    breaker_tripped: null,
    failed: 0,
    errors: [],
    scores_updated: 0,
    hot_leads_alerted: 0,
    ab_tests_promoted: 0,
    booking_reminders_sent: 0,
  };
}

function loadEngine(opts: {
  send: () => Promise<{ status: DispatchOutcome; error?: string }>;
  outcomes: DispatchOutcome[];
}) {
  const activities: Array<{ activity_type: string }> = [];
  const engine = moduleUnderTest<
    typeof import("./engine.ts") & {
      executeStep: (
        db: AdminClient,
        step: WorkflowStep,
        lead: Lead,
        workflow: Workflow,
        enrollment: Enrollment,
        index: number,
        settings: CrmSettings,
        summary: TickSummary
      ) => Promise<{ advance: boolean; deferUntil?: Date; halt?: boolean }>;
      processEnrollment: (
        db: AdminClient,
        enrollment: Enrollment & { workflows: Workflow | null; leads: Lead | null },
        settings: CrmSettings,
        summary: TickSummary
      ) => Promise<void>;
    }
  >(
    "./engine.ts",
    {
      "./activity": { logActivity: async (_db: unknown, row: { activity_type: string }) => activities.push(row) },
      "@/lib/money/engagements": {},
      "@/lib/money/db": {},
      "@/lib/money/state": {},
      "./email": { sendCrmEmail: opts.send },
      "./settings": {},
      "./merge": { renderMergeTags: (value: string) => value },
      "./scoring": {},
      "./alerts": {},
      "./abtest": {},
      "./dispatch-reservation": {
        reserveWorkflowDispatch: async () => ({
          ok: true,
          code: "reserved",
          reservationId: "res-1",
          recovered: false,
          expiresAt: null,
        }),
        completeWorkflowDispatch: async (_db: unknown, _id: string, outcome: DispatchOutcome) => {
          opts.outcomes.push(outcome);
        },
      },
      "./retention": { SKOOL_TAGS: [] },
      "./bookings": {},
      "./health": {},
      "./pagination": {},
      "./types": { parseSteps: (steps: unknown) => steps },
    },
    "\nexport { executeStep, processEnrollment };\n"
  );
  return { engine, activities };
}

function fixture() {
  const step: WorkflowStep = {
    id: "email-1",
    type: "send_email",
    config: { subject: "Hello", body_md: "Hi {{first_name}}" },
  };
  const db = fakeDb({
    leads: [
      {
        id: LEAD,
        first_name: "Alex",
        email: "alex@example.com",
        tags: [],
        custom: {},
        email_status: "subscribed",
        status: "new",
      },
    ],
    workflows: [
      {
        id: WORKFLOW,
        name: "Nurture",
        status: "active",
        completed_count: 0,
        steps: [step],
      },
    ],
    workflow_enrollments: [
      {
        id: ENROLLMENT,
        workflow_id: WORKFLOW,
        lead_id: LEAD,
        status: "active",
        current_step: 0,
        next_run_at: new Date().toISOString(),
        context: {},
        last_error: null,
      },
    ],
    lead_activities: [],
  });
  return { db, step };
}

function enrollmentRow(db: FakeDb, workflow: Workflow, lead: Lead) {
  const row = db.rows("workflow_enrollments")[0] as unknown as Enrollment;
  return { ...row, workflows: workflow, leads: lead };
}

test("a final email after conversion leaves the enrollment exited and does not record completion", async () => {
  const { db } = fixture();
  const outcomes: DispatchOutcome[] = [];
  const { engine, activities } = loadEngine({
    outcomes,
    send: async () => {
      const enrollment = db.rows("workflow_enrollments")[0];
      enrollment.status = "exited";
      enrollment.exit_reason = "cornerman_conversion";
      return { status: "simulated" };
    },
  });
  const workflow = db.rows("workflows")[0] as unknown as Workflow;
  const lead = db.rows("leads")[0] as unknown as Lead;
  const summary = emptySummary();
  await engine.processEnrollment(admin(db), enrollmentRow(db, workflow, lead), settings, summary);
  assert.equal(db.rows("workflow_enrollments")[0].status, "exited");
  assert.equal(db.rows("workflow_enrollments")[0].exit_reason, "cornerman_conversion");
  assert.equal(db.rows("workflows")[0].completed_count, 0);
  assert.equal(summary.completed, 0);
  assert.equal(summary.failed, 0);
  assert.deepEqual(outcomes, ["simulated"]);
  assert.equal(activities.some((row) => row.activity_type === "workflow_completed"), false);
  assert.equal(activities.some((row) => row.activity_type === "workflow_failed"), false);
});

test("a final email failure after conversion does not record workflow failure", async () => {
  const { db } = fixture();
  db.rows("workflow_enrollments")[0].context = { attempts: 4 };
  const outcomes: DispatchOutcome[] = [];
  const { engine, activities } = loadEngine({
    outcomes,
    send: async () => {
      const enrollment = db.rows("workflow_enrollments")[0];
      enrollment.status = "exited";
      enrollment.exit_reason = "cornerman_conversion";
      return { status: "failed", error: "provider rejected" };
    },
  });
  const workflow = db.rows("workflows")[0] as unknown as Workflow;
  const lead = db.rows("leads")[0] as unknown as Lead;
  const summary = emptySummary();
  await engine.processEnrollment(admin(db), enrollmentRow(db, workflow, lead), settings, summary);
  assert.equal(db.rows("workflow_enrollments")[0].status, "exited");
  assert.equal(db.rows("workflow_enrollments")[0].exit_reason, "cornerman_conversion");
  assert.equal(summary.failed, 0);
  assert.equal(summary.completed, 0);
  assert.deepEqual(outcomes, ["failed"]);
  assert.equal(activities.some((row) => row.activity_type === "workflow_failed"), false);
  assert.equal(activities.some((row) => row.activity_type === "workflow_completed"), false);
});

test("provider rejection records a failed reservation before the step throws", async () => {
  const { db, step } = fixture();
  const outcomes: DispatchOutcome[] = [];
  const { engine } = loadEngine({
    outcomes,
    send: async () => ({ status: "failed", error: "provider rejected" }),
  });
  const workflow = db.rows("workflows")[0] as unknown as Workflow;
  const lead = db.rows("leads")[0] as unknown as Lead;
  const enrollment = db.rows("workflow_enrollments")[0] as unknown as Enrollment;
  const summary = emptySummary();
  await assert.rejects(
    engine.executeStep(admin(db), step, lead, workflow, enrollment, 0, settings, summary),
    /send_email failed: provider rejected/
  );
  assert.deepEqual(outcomes, ["failed"]);
});

test("quota rejection records a failed reservation before deferring", async () => {
  const { db, step } = fixture();
  const outcomes: DispatchOutcome[] = [];
  const { engine } = loadEngine({
    outcomes,
    send: async () => ({ status: "failed", error: "quota exceeded" }),
  });
  const workflow = db.rows("workflows")[0] as unknown as Workflow;
  const lead = db.rows("leads")[0] as unknown as Lead;
  const enrollment = db.rows("workflow_enrollments")[0] as unknown as Enrollment;
  const summary = emptySummary();
  const outcome = await engine.executeStep(admin(db), step, lead, workflow, enrollment, 0, settings, summary);
  assert.equal(outcome.advance, false);
  assert.ok(outcome.deferUntil);
  assert.equal(summary.emails_deferred_quota, 1);
  assert.deepEqual(outcomes, ["failed"]);
});

test("an uninterrupted final email still completes the workflow", async () => {
  const { db } = fixture();
  const outcomes: DispatchOutcome[] = [];
  const { engine, activities } = loadEngine({
    outcomes,
    send: async () => ({ status: "simulated" }),
  });
  const workflow = db.rows("workflows")[0] as unknown as Workflow;
  const lead = db.rows("leads")[0] as unknown as Lead;
  const summary = emptySummary();
  await engine.processEnrollment(admin(db), enrollmentRow(db, workflow, lead), settings, summary);
  assert.equal(db.rows("workflow_enrollments")[0].status, "completed");
  assert.equal(db.rows("workflows")[0].completed_count, 1);
  assert.equal(summary.completed, 1);
  assert.deepEqual(outcomes, ["simulated"]);
  assert.equal(activities.some((row) => row.activity_type === "workflow_completed"), true);
});
