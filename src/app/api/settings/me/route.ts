/**
 * GET /api/settings/me — who am I? Role + id for the current session, so the
 * client shell (sidebar) can trim navigation for social-role users. The real
 * enforcement lives in middleware (pages) and lib/api/auth (API routes).
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";

export async function GET(request: NextRequest) {
  const auth = await authenticateSession(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);
  if (auth.mode !== "session") return unauthorizedResponse("Session required");
  return NextResponse.json({ userId: auth.userId, role: auth.role });
}
