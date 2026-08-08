/**
 * DELETE /api/social/accounts/[id] — disconnect an account. Soft: the row
 * stays (published targets and their metrics keep their history) but no new
 * posts can target it; reconnecting the same page/channel reactivates it.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await context.params;
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("social_accounts")
    .update({ status: "disconnected", access_token: null, refresh_token: null })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
