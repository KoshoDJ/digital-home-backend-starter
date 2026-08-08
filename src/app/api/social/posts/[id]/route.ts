/**
 * GET    /api/social/posts/[id] — post with targets + metric history.
 * PATCH  /api/social/posts/[id] — edit caption/title/schedule/targets while
 *        the post hasn't gone out yet; also cancel (status: 'canceled') or
 *        re-arm a draft/canceled post (status: 'scheduled').
 * DELETE /api/social/posts/[id] — delete the post and its storage object.
 */
import { NextRequest, NextResponse } from "next/server";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import {
  CAROUSEL_MAX_SLIDES,
  CAROUSEL_MIN_SLIDES,
  CAROUSEL_PLATFORMS,
} from "@/lib/social/types";
import { deleteMediaObjects } from "@/lib/social/upload";

type RouteContext = { params: Promise<{ id: string }> };

const EDITABLE_STATUSES = ["draft", "scheduled", "canceled", "failed"];

/**
 * Of these storage paths, the ones no OTHER post still references — as a
 * carousel slide or as a video. Duplicated posts (e.g. a retried composer
 * save) share the same uploaded object, and deleting one post must never
 * yank the file out from under its sibling mid-publish.
 */
async function unreferencedPaths(
  supabase: ReturnType<typeof createAdminClient>,
  postId: string,
  candidates: string[]
): Promise<string[]> {
  if (!candidates.length) return [];
  const still = new Set<string>();
  const { data: mediaRefs } = await supabase
    .from("social_post_media")
    .select("path")
    .in("path", candidates)
    .neq("post_id", postId);
  for (const r of mediaRefs || []) if (r.path) still.add(r.path);
  const { data: videoRefs } = await supabase
    .from("social_posts")
    .select("video_path")
    .in("video_path", candidates)
    .neq("id", postId);
  for (const r of videoRefs || []) if (r.video_path) still.add(r.video_path);
  return candidates.filter((p) => !still.has(p));
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await context.params;
  const supabase = createAdminClient();
  const { data: post, error } = await supabase
    .from("social_posts")
    .select(
      "*, targets:social_post_targets(*, account:social_accounts(id, platform, name, username)), media:social_post_media(*)"
    )
    .eq("id", id)
    .single();
  if (error || !post) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const targetIds = (post.targets || []).map((t: { id: string }) => t.id);
  let metrics: unknown[] = [];
  if (targetIds.length) {
    const { data } = await supabase
      .from("social_metrics")
      .select("*")
      .in("target_id", targetIds)
      .order("captured_at", { ascending: true });
    metrics = data || [];
  }
  return NextResponse.json({ post, metrics });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await context.params;
  const body = (await request.json().catch(() => null)) as {
    title?: string;
    caption?: string;
    scheduled_at?: string | null;
    status?: "draft" | "scheduled" | "canceled";
    account_ids?: string[];
    video_path?: string;
    video_url?: string;
    media?: Array<{ url: string; path?: string | null; kind?: "image" | "video" }>;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const supabase = createAdminClient();
  const { data: post } = await supabase.from("social_posts").select("*").eq("id", id).single();
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!EDITABLE_STATUSES.includes(post.status)) {
    return NextResponse.json(
      { error: `A ${post.status} post can no longer be edited` },
      { status: 409 }
    );
  }

  const update: Record<string, unknown> = {};
  if (body.title !== undefined) update.title = body.title?.trim() || null;
  if (body.caption !== undefined) update.caption = body.caption;
  if (body.scheduled_at !== undefined) update.scheduled_at = body.scheduled_at;
  if (body.video_path !== undefined) update.video_path = body.video_path;
  if (body.video_url !== undefined) update.video_url = body.video_url;
  if (body.status && ["draft", "scheduled", "canceled"].includes(body.status)) {
    update.status = body.status;
    if (body.status === "scheduled") update.error = null;
  }

  // Re-arming for another run: put failed targets back in the queue.
  if (update.status === "scheduled" && post.status === "failed") {
    await supabase
      .from("social_post_targets")
      .update({ status: "pending", error: null, platform_ref: {} })
      .eq("post_id", id)
      .eq("status", "failed");
  }

  // Replace the carousel slide set if provided (delete + reinsert keeps
  // ordering simple; removed slides' storage objects are cleaned up).
  let mediaAfterEdit: Array<{ url: string }> | null = null;
  if (post.post_type === "carousel" && Array.isArray(body.media)) {
    const incoming = body.media.filter((m) => typeof m?.url === "string" && m.url);
    if (incoming.length > CAROUSEL_MAX_SLIDES) {
      return NextResponse.json(
        { error: `A carousel takes at most ${CAROUSEL_MAX_SLIDES} slides (Instagram's cap)` },
        { status: 400 }
      );
    }
    const { data: existingMedia } = await supabase
      .from("social_post_media")
      .select("path, url")
      .eq("post_id", id);
    const keptUrls = new Set(incoming.map((m) => m.url));
    const orphanPaths = (existingMedia || [])
      .filter((m) => m.path && !keptUrls.has(m.url))
      .map((m) => m.path as string);

    await supabase.from("social_post_media").delete().eq("post_id", id);
    if (incoming.length) {
      const { error: mediaError } = await supabase.from("social_post_media").insert(
        incoming.map((m, i) => ({
          post_id: id,
          position: i,
          kind: m.kind === "video" ? ("video" as const) : ("image" as const),
          path: m.path || null,
          url: m.url,
        }))
      );
      if (mediaError) {
        return NextResponse.json({ error: mediaError.message }, { status: 500 });
      }
    }
    const removable = await unreferencedPaths(supabase, id, orphanPaths);
    await deleteMediaObjects(supabase, removable);
    mediaAfterEdit = incoming;
  }

  const scheduledAt = (update.scheduled_at ?? post.scheduled_at) as string | null;
  if (post.post_type === "carousel") {
    if (update.status === "scheduled") {
      let slideCount = mediaAfterEdit?.length;
      if (slideCount === undefined) {
        const { count } = await supabase
          .from("social_post_media")
          .select("id", { count: "exact", head: true })
          .eq("post_id", id);
        slideCount = count ?? 0;
      }
      if (!scheduledAt || slideCount < CAROUSEL_MIN_SLIDES) {
        return NextResponse.json(
          { error: "Scheduling an image post needs a time and at least 1 slide" },
          { status: 400 }
        );
      }
    }
  } else {
    const videoUrl = (update.video_url ?? post.video_url) as string | null;
    if (update.status === "scheduled" && (!scheduledAt || !videoUrl)) {
      return NextResponse.json(
        { error: "Scheduling needs both a video and a time" },
        { status: 400 }
      );
    }
  }

  if (Object.keys(update).length) {
    const { error } = await supabase.from("social_posts").update(update).eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Replace target set if provided (only touch untouched targets).
  if (Array.isArray(body.account_ids)) {
    const { data: existing } = await supabase
      .from("social_post_targets")
      .select("id, account_id, status")
      .eq("post_id", id);
    const keep = new Set(body.account_ids);
    const current = new Map((existing || []).map((t) => [t.account_id, t]));

    const removable = (existing || []).filter(
      (t) => !keep.has(t.account_id) && ["pending", "failed", "skipped"].includes(t.status)
    );
    if (removable.length) {
      await supabase
        .from("social_post_targets")
        .delete()
        .in("id", removable.map((t) => t.id));
    }

    const toAdd = body.account_ids.filter((accountId) => !current.has(accountId));
    if (toAdd.length) {
      const { data: accounts } = await supabase
        .from("social_accounts")
        .select("id, platform")
        .in("id", toAdd)
        .eq("status", "active");
      const eligible = (accounts || []).filter(
        (a) => post.post_type !== "carousel" || CAROUSEL_PLATFORMS.includes(a.platform)
      );
      if (eligible.length) {
        await supabase.from("social_post_targets").insert(
          eligible.map((a) => ({ post_id: id, account_id: a.id, platform: a.platform }))
        );
      }
    }
  }

  const { data: fresh } = await supabase
    .from("social_posts")
    .select(
      "*, targets:social_post_targets(*, account:social_accounts(id, platform, name, username)), media:social_post_media(*)"
    )
    .eq("id", id)
    .single();
  return NextResponse.json({ post: fresh });
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const { id } = await context.params;
  const supabase = createAdminClient();
  const { data: post } = await supabase.from("social_posts").select("*").eq("id", id).single();
  if (!post) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (post.status === "publishing") {
    return NextResponse.json(
      { error: "Post is mid-publish — wait for it to finish, then delete" },
      { status: 409 }
    );
  }

  const { data: mediaRows } = await supabase
    .from("social_post_media")
    .select("path")
    .eq("post_id", id);
  const paths = await unreferencedPaths(supabase, id, [
    ...(post.video_path ? [post.video_path] : []),
    ...(mediaRows || []).map((m) => m.path).filter((p): p is string => Boolean(p)),
  ]);
  await deleteMediaObjects(supabase, paths);
  const { error } = await supabase.from("social_posts").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
