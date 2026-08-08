/**
 * POST /api/social/tick — advance the social publish engine: promote due
 * scheduled posts, walk in-flight platform publishes, refresh performance
 * snapshots. Called by the scheduled GitHub Action (~every 10 min), the
 * studio's refresh button, or any authenticated agent. Idempotent.
 *
 * Body (optional): { metricsOnly?: boolean; postId?: string }
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { runSocialTick } from "@/lib/social/publisher";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = (await request.json().catch(() => ({}))) as {
    metricsOnly?: boolean;
    metricsForce?: boolean;
    postId?: string;
  };
  const supabase = createAdminClient();
  const summary = await runSocialTick(supabase, {
    metricsOnly: Boolean(body.metricsOnly),
    metricsForce: Boolean(body.metricsForce),
    postId: typeof body.postId === "string" && body.postId ? body.postId : undefined,
  });
  return NextResponse.json({ ok: true, ...summary });
}
