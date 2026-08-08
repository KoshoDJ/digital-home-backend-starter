/**
 * GET /api/social/oauth/google — YouTube channel connect, same one-route
 * shape as the Meta flow. Stores the offline refresh_token per channel.
 * Needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (wrangler secret put).
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  googleAuthorizeUrl,
  googleExchangeCode,
  googleOAuthConfigured,
  ytOwnChannel,
} from "@/lib/social/youtube";

const STATE_COOKIE = "social_oauth_state_g";

export async function GET(request: NextRequest) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  if (!googleOAuthConfigured()) {
    return NextResponse.json(
      { error: "Google OAuth is not configured — set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET" },
      { status: 503 }
    );
  }

  const { searchParams, origin } = request.nextUrl;
  const redirectUri = `${origin}/api/social/oauth/google`;
  const accountsUrl = new URL("/social/accounts", origin);

  if (searchParams.get("error")) {
    accountsUrl.searchParams.set("error", "Google connection was canceled");
    return NextResponse.redirect(accountsUrl);
  }

  const code = searchParams.get("code");
  if (!code) {
    const state = randomUUID();
    const res = NextResponse.redirect(googleAuthorizeUrl(redirectUri, state));
    res.cookies.set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
      path: "/api/social/oauth",
    });
    return res;
  }

  if (searchParams.get("state") !== request.cookies.get(STATE_COOKIE)?.value) {
    accountsUrl.searchParams.set("error", "OAuth state mismatch — try connecting again");
    return NextResponse.redirect(accountsUrl);
  }

  try {
    const { accessToken, refreshToken } = await googleExchangeCode(code, redirectUri);
    const channel = await ytOwnChannel(accessToken);
    const supabase = createAdminClient();

    // Google only returns refresh_token on consent; keep the old one otherwise.
    const { data: existing } = await supabase
      .from("social_accounts")
      .select("refresh_token")
      .eq("platform", "youtube")
      .eq("external_id", channel.id)
      .maybeSingle();

    await supabase.from("social_accounts").upsert(
      {
        platform: "youtube",
        external_id: channel.id,
        name: channel.title,
        username: channel.customUrl,
        refresh_token: refreshToken || existing?.refresh_token || null,
        status: "active",
        connected_at: new Date().toISOString(),
        metadata: { thumbnail: channel.thumbnail } as never,
      },
      { onConflict: "platform,external_id" }
    );
    accountsUrl.searchParams.set("connected", "1");
  } catch (e) {
    accountsUrl.searchParams.set("error", e instanceof Error ? e.message : "Google connection failed");
  }

  const res = NextResponse.redirect(accountsUrl);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
