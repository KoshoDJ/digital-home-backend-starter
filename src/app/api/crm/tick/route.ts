/**
 * POST /api/crm/tick — run the workflow engine over all due enrollments.
 * Called by the scheduled GitHub Action (~every 10 min), the admin
 * "Run engine" button, or any authenticated agent. Idempotent.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { runEngineTick } from "@/lib/crm/engine";

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const supabase = createAdminClient();
  const summary = await runEngineTick(supabase);
  return NextResponse.json({ ok: true, ...summary });
}
