/**
 * GET  /api/social/accounts — connected platform accounts (tokens redacted).
 * POST /api/social/accounts — manual connect without the OAuth apps:
 *   { platform: "meta", page_token }        — a page token from Graph API
 *     Explorer; stores the FB page and its linked IG account in one go.
 *   { platform: "youtube", refresh_token }  — a Google OAuth refresh token
 *     (needs GOOGLE_CLIENT_ID/SECRET set to mint access tokens).
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { metaDebugPageToken, metaOAuthConfigured } from "@/lib/social/meta";
import { googleOAuthConfigured, googleRefreshAccessToken, ytOwnChannel } from "@/lib/social/youtube";

function redact<T extends { access_token?: string | null; refresh_token?: string | null }>(a: T) {
  return {
    ...a,
    access_token: a.access_token ? "•••" : null,
    refresh_token: a.refresh_token ? "•••" : null,
  };
}

export async function GET(request: NextRequest) {
  // The social role has to read the connected accounts — they're the publish
  // targets in the composer. Connecting/disconnecting stays admin-only below.
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);
  const canManage = auth.mode !== "session" || auth.role === "admin";

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("social_accounts")
    .select("*")
    .order("platform")
    .order("created_at");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    accounts: (data || []).map(redact),
    oauth: { meta: metaOAuthConfigured(), google: googleOAuthConfigured() },
    can_manage: canManage,
  });
}

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = (await request.json().catch(() => null)) as {
    platform?: "meta" | "youtube";
    page_token?: string;
    refresh_token?: string;
  } | null;
  if (!body?.platform) {
    return NextResponse.json({ error: "platform is required" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const connected: string[] = [];

  try {
    if (body.platform === "meta") {
      if (!body.page_token) {
        return NextResponse.json({ error: "page_token is required" }, { status: 400 });
      }
      const info = await metaDebugPageToken(body.page_token);
      await supabase.from("social_accounts").upsert(
        {
          platform: "facebook",
          external_id: info.pageId,
          name: info.pageName,
          access_token: body.page_token,
          status: "active",
          connected_at: new Date().toISOString(),
        },
        { onConflict: "platform,external_id" }
      );
      connected.push(`Facebook page: ${info.pageName}`);

      if (info.igAccount) {
        await supabase.from("social_accounts").upsert(
          {
            platform: "instagram",
            external_id: info.igAccount.id,
            name: info.igAccount.name || info.igAccount.username || "Instagram",
            username: info.igAccount.username || null,
            access_token: body.page_token,
            status: "active",
            connected_at: new Date().toISOString(),
            metadata: { page_id: info.pageId } as never,
          },
          { onConflict: "platform,external_id" }
        );
        connected.push(`Instagram: @${info.igAccount.username || info.igAccount.id}`);
      }
    } else {
      if (!body.refresh_token) {
        return NextResponse.json({ error: "refresh_token is required" }, { status: 400 });
      }
      if (!googleOAuthConfigured()) {
        return NextResponse.json(
          { error: "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first" },
          { status: 503 }
        );
      }
      const accessToken = await googleRefreshAccessToken(body.refresh_token);
      const channel = await ytOwnChannel(accessToken);
      await supabase.from("social_accounts").upsert(
        {
          platform: "youtube",
          external_id: channel.id,
          name: channel.title,
          username: channel.customUrl,
          refresh_token: body.refresh_token,
          status: "active",
          connected_at: new Date().toISOString(),
          metadata: { thumbnail: channel.thumbnail } as never,
        },
        { onConflict: "platform,external_id" }
      );
      connected.push(`YouTube: ${channel.title}`);
    }
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Token validation failed" },
      { status: 400 }
    );
  }

  return NextResponse.json({ ok: true, connected }, { status: 201 });
}
