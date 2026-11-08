import type { AdminClient } from "./types";

export type DispatchOutcome = "sent" | "simulated" | "suppressed" | "failed";

export type ReserveResult =
  | { ok: true; code: "reserved"; reservationId: string; recovered: boolean; expiresAt: string | null }
  | { ok: false; code: "converted" | "not_active" | "step_mismatch" | "already_reserved" | "already_dispatched" | "not_found"; expiresAt?: string | null };

type RpcRow = {
  ok?: boolean;
  code?: string;
  reservation_id?: string;
  recovered?: boolean;
  expires_at?: string;
};

export async function reserveWorkflowDispatch(
  supabase: AdminClient,
  enrollmentId: string,
  stepNumber: number,
  leaseSeconds = 600
): Promise<ReserveResult> {
  const { data, error } = await supabase.rpc("reserve_workflow_dispatch_v1", {
    p_enrollment_id: enrollmentId,
    p_step_number: stepNumber,
    p_lease_seconds: leaseSeconds,
  });
  if (error) {
    return { ok: false, code: "not_found" };
  }
  const row = (data ?? {}) as RpcRow;
  if (row.ok && row.code === "reserved" && row.reservation_id) {
    return {
      ok: true,
      code: "reserved",
      reservationId: row.reservation_id,
      recovered: row.recovered === true,
      expiresAt: row.expires_at ?? null,
    };
  }
  const code = row.code;
  if (
    code === "converted" ||
    code === "not_active" ||
    code === "step_mismatch" ||
    code === "already_reserved" ||
    code === "already_dispatched" ||
    code === "not_found"
  ) {
    return { ok: false, code, expiresAt: row.expires_at ?? null };
  }
  return { ok: false, code: "not_found" };
}

export async function completeWorkflowDispatch(
  supabase: AdminClient,
  reservationId: string,
  outcome: DispatchOutcome
): Promise<void> {
  const { error } = await supabase.rpc("complete_workflow_dispatch_v1", {
    p_reservation_id: reservationId,
    p_outcome: outcome,
  });
  if (error) throw new Error("dispatch reservation could not be completed");
}
