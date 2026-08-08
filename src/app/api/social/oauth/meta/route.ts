/**
 * GET /api/social/oauth/meta — Meta OAuth in one route.
 * No ?code → start: set a state cookie and bounce to Facebook's dialog.
 * ?code   → callback: exchange for a long-lived token, pull every managed
 *           page + linked IG business account, store them all, and land back
 *           on /social/accounts.
 *
 * Needs META_APP_ID / META_APP_SECRET (wrangler secret put). Returns 503
 * cleanly when unset — the manual page-token path still works without it.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authenticateSession, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  metaAuthorizeUrl,
  metaExchangeCode,
  metaListPages,
  metaLongLivedToken,
  metaOAuthConfigured,
} from "@/lib/social/meta";

const STATE_COOKIE = "social_oauth_state";

export async function GET(request: NextRequest) {
  const auth = await authenticateSession(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  if (!metaOAuthConfigured()) {
    return NextResponse.json(
      { error: "Meta OAuth is not configured — set META_APP_ID and META_APP_SECRET, or connect with a page token instead" },
      { status: 503 }
    );
  }

  const { searchParams, origin } = request.nextUrl;
  const redirectUri = `${origin}/api/social/oauth/meta`;
  const accountsUrl = new URL("/social/accounts", origin);

  if (searchParams.get("error")) {
    accountsUrl.searchParams.set("error", searchParams.get("error_description") || "Meta connection was canceled");
    return NextResponse.redirect(accountsUrl);
  }

  const code = searchParams.get("code");
  if (!code) {
    const state = randomUUID();
    const res = NextResponse.redirect(metaAuthorizeUrl(redirectUri, state));
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
    const shortToken = await metaExchangeCode(code, redirectUri);
    const userToken = await metaLongLivedToken(shortToken);
    const pages = await metaListPages(userToken);
    if (!pages.length) {
      accountsUrl.searchParams.set("error", "No Facebook pages on this account — the connecting user must manage the brand page");
      return NextResponse.redirect(accountsUrl);
    }

    const supabase = createAdminClient();
    let connected = 0;
    for (const page of pages) {
      await supabase.from("social_accounts").upsert(
        {
          platform: "facebook",
          external_id: page.id,
          name: page.name,
          access_token: page.access_token,
          status: "active",
          connected_at: new Date().toISOString(),
        },
        { onConflict: "platform,external_id" }
      );
      connected++;
      if (page.instagram_business_account) {
        const ig = page.instagram_business_account;
        await supabase.from("social_accounts").upsert(
          {
            platform: "instagram",
            external_id: ig.id,
            name: ig.name || ig.username || "Instagram",
            username: ig.username || null,
            access_token: page.access_token,
            status: "active",
            connected_at: new Date().toISOString(),
            metadata: { page_id: page.id, avatar: ig.profile_picture_url || null } as never,
          },
          { onConflict: "platform,external_id" }
        );
        connected++;
      }
    }
    accountsUrl.searchParams.set("connected", String(connected));
  } catch (e) {
    accountsUrl.searchParams.set("error", e instanceof Error ? e.message : "Meta connection failed");
  }

  const res = NextResponse.redirect(accountsUrl);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
