/**
 * The social publish engine. Idempotent — driven by the social-tick GitHub
 * Action every ~10 minutes, the "Publish now" button, or any authenticated
 * agent, mirroring the CRM engine's design.
 *
 * Lifecycle: a post goes scheduled → publishing when due; each target then
 * walks pending → (processing) → published/failed. Meta ingests async, so a
 * target can sit in `processing` across ticks with its container/video id in
 * platform_ref. When no target is in flight the post rolls up to
 * published / partial / failed.
 */
import type { AdminClient } from "@/lib/crm/types";
import type { PublishStep, SocialAccount, SocialMedia, SocialPost, SocialTarget } from "./types";
import {
  fbAdvance,
  fbFinishReel,
  fbPublishPhotoPost,
  fbStartReel,
  igAdvance,
  igCreateCarouselContainer,
  igCreateCarouselItem,
  igCreateContainer,
  igCreateImagePost,
} from "./meta";
import {
  googleRefreshAccessToken,
  type YouTubeUploadRef,
  ytResumeVideoUpload,
  ytStartVideoUpload,
} from "./youtube";
import { refreshDueMetrics } from "./metrics";

const MAX_ATTEMPTS = 3;
/** Give Meta this long to transcode before we call the target dead. */
const PROCESSING_DEADLINE_MS = 45 * 60 * 1000;
/** A pending-target claim older than this came from a dead worker and may be recovered. */
const TARGET_LEASE_MS = 10 * 60 * 1000;
/** Inline poll budget after kicking off an IG container (publish-now UX). */
const IG_INLINE_POLLS = 4;
const IG_INLINE_POLL_DELAY_MS = 8000;

export interface SocialTickSummary {
  postsDue: number;
  targetsPublished: number;
  targetsProcessing: number;
  targetsFailed: number;
  metricsRefreshed: number;
  errors: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function targetCaption(post: SocialPost, target: SocialTarget): string {
  return target.caption_override ?? post.caption ?? "";
}

/** First publish step for a pending image-post target (1 photo or a carousel). */
async function beginCarouselPublish(
  post: SocialPost,
  target: SocialTarget,
  account: SocialAccount,
  media: SocialMedia[]
): Promise<PublishStep> {
  const images = media
    .filter((m) => m.kind === "image")
    .sort((a, b) => a.position - b.position)
    // IG caches media-fetch failures per URL (code 9004): on a retry, a
    // cache-busting param makes Meta fetch fresh instead of re-failing.
    .map((m) => (target.attempts > 0 ? `${m.url}${m.url.includes("?") ? "&" : "?"}r=${target.attempts}` : m.url));
  if (images.length < 1) {
    return { state: "failed", error: "Image post has no slides attached" };
  }
  const caption = targetCaption(post, target);
  if (!account.access_token) {
    return { state: "failed", error: `${target.platform} account has no token` };
  }

  if (target.platform === "instagram") {
    let containerId: string;
    if (images.length === 1) {
      // Single photo: one IMAGE container, caption on the container itself.
      containerId = await igCreateImagePost(
        account.external_id,
        account.access_token,
        images[0],
        caption
      );
    } else {
      const childIds: string[] = [];
      for (const url of images) {
        childIds.push(await igCreateCarouselItem(account.external_id, account.access_token, url));
      }
      containerId = await igCreateCarouselContainer(
        account.external_id,
        account.access_token,
        childIds,
        caption
      );
    }
    // Same container walk as Reels — images cook fast, so inline polls
    // usually finish it in one call.
    let step: PublishStep = { state: "processing", ref: { container_id: containerId } };
    for (let i = 0; i < IG_INLINE_POLLS && step.state === "processing"; i++) {
      await sleep(IG_INLINE_POLL_DELAY_MS);
      step = await igAdvance(account.external_id, account.access_token, {
        container_id: containerId,
      });
    }
    return step;
  }

  if (target.platform === "facebook") {
    const { postId, permalink } = await fbPublishPhotoPost(
      account.external_id,
      account.access_token,
      images,
      caption
    );
    return { state: "published", externalId: postId, externalUrl: permalink };
  }

  return { state: "failed", error: "YouTube has no carousel format" };
}

/** First publish step for a pending target. */
async function beginPublish(
  post: SocialPost,
  target: SocialTarget,
  account: SocialAccount,
  media: SocialMedia[]
): Promise<PublishStep> {
  // Absolute backstop: a target with a final platform id must never enter any
  // platform's create/upload path again, regardless of its local status.
  if (target.external_id) {
    return {
      state: "published",
      externalId: target.external_id,
      externalUrl:
        target.external_url ||
        (target.platform === "youtube"
          ? `https://www.youtube.com/shorts/${target.external_id}`
          : null),
    };
  }
  if (post.post_type === "carousel") {
    return beginCarouselPublish(post, target, account, media);
  }
  if (!post.video_url) return { state: "failed", error: "Post has no video attached" };
  const caption = targetCaption(post, target);

  if (target.platform === "instagram") {
    if (!account.access_token) return { state: "failed", error: "Instagram account has no token" };
    const containerId = await igCreateContainer(
      account.external_id,
      account.access_token,
      post.video_url,
      caption
    );
    // Inline polls so "Publish now" usually completes in one call.
    let step: PublishStep = { state: "processing", ref: { container_id: containerId } };
    for (let i = 0; i < IG_INLINE_POLLS && step.state === "processing"; i++) {
      await sleep(IG_INLINE_POLL_DELAY_MS);
      step = await igAdvance(account.external_id, account.access_token, {
        container_id: containerId,
      });
    }
    return step;
  }

  if (target.platform === "facebook") {
    if (!account.access_token) return { state: "failed", error: "Facebook page has no token" };
    const videoId = await fbStartReel(account.external_id, account.access_token, post.video_url);
    await fbFinishReel(account.external_id, account.access_token, videoId, caption);
    return { state: "processing", ref: { video_id: videoId } };
  }

  // YouTube is two-phase: persist the session URI on this tick, then upload
  // chunks on the next. No bytes move until retry state is durable.
  if (!account.refresh_token) return { state: "failed", error: "YouTube channel has no refresh token" };
  const accessToken = await googleRefreshAccessToken(account.refresh_token);
  const existingRef = (target.platform_ref || {}) as Partial<YouTubeUploadRef>;
  if (existingRef.youtube_upload_url) {
    const uploaded = await ytResumeVideoUpload(accessToken, existingRef as YouTubeUploadRef);
    return { state: "published", externalId: uploaded.videoId, externalUrl: uploaded.url };
  }
  const ref = await ytStartVideoUpload(accessToken, {
    videoUrl: post.video_url,
    title: post.title || caption.split("\n")[0]?.slice(0, 100) || "Short",
    description: caption,
  });
  return { state: "processing", ref: { ...ref } };
}

/** Poll step for a target already in `processing`. */
async function continuePublish(
  target: SocialTarget,
  account: SocialAccount
): Promise<PublishStep> {
  const ref = (target.platform_ref || {}) as Record<string, unknown>;
  if (target.platform === "instagram") {
    if (!account.access_token) return { state: "failed", error: "Instagram account token missing" };
    return igAdvance(account.external_id, account.access_token, ref);
  }
  if (target.platform === "facebook") {
    if (!account.access_token) return { state: "failed", error: "Facebook account token missing" };
    return fbAdvance(account.external_id, account.access_token, ref);
  }
  if (!account.refresh_token) return { state: "failed", error: "YouTube channel has no refresh token" };
  const accessToken = await googleRefreshAccessToken(account.refresh_token);
  const uploaded = await ytResumeVideoUpload(accessToken, ref as unknown as YouTubeUploadRef);
  return { state: "published", externalId: uploaded.videoId, externalUrl: uploaded.url };
}

async function applyStep(
  supabase: AdminClient,
  target: SocialTarget,
  step: PublishStep,
  attemptsDelta: number
): Promise<void> {
  if (step.state === "published") {
    const { error } = await supabase
      .from("social_post_targets")
      .update({
        status: "published",
        external_id: step.externalId,
        external_url: step.externalUrl,
        published_at: new Date().toISOString(),
        error: null,
        attempts: target.attempts + attemptsDelta,
      })
      .eq("id", target.id);
    if (error) throw new Error(`Could not save published target: ${error.message}`);
  } else if (step.state === "processing") {
    const { error } = await supabase
      .from("social_post_targets")
      .update({
        status: "processing",
        platform_ref: step.ref as never,
        error: null,
        attempts: target.attempts + attemptsDelta,
      })
      .eq("id", target.id);
    if (error) throw new Error(`Could not save processing target: ${error.message}`);
  } else {
    const attempts = target.attempts + attemptsDelta;
    // Processing failures are terminal (the platform rejected the video);
    // pending failures retry until MAX_ATTEMPTS in case it was transient. A
    // YouTube transport failure is explicitly retryable because its durable
    // session can resume without creating another upload.
    const terminal = (!step.retryable && target.status !== "pending") || attempts >= MAX_ATTEMPTS;
    const { error } = await supabase
      .from("social_post_targets")
      .update({
        status: terminal ? "failed" : target.status === "processing" ? "processing" : "pending",
        error: step.error.slice(0, 1000),
        attempts,
      })
      .eq("id", target.id);
    if (error) throw new Error(`Could not save failed target: ${error.message}`);
  }
}

/** Roll a publishing post up once none of its targets are still in flight. */
async function rollupPost(supabase: AdminClient, postId: string): Promise<void> {
  const { data: targets } = await supabase
    .from("social_post_targets")
    .select("status")
    .eq("post_id", postId);
  if (!targets?.length) return;

  const counts = { inFlight: 0, pending: 0, published: 0, failed: 0 };
  for (const t of targets) {
    if (["publishing", "processing"].includes(t.status)) counts.inFlight++;
    else if (t.status === "pending") counts.pending++;
    else if (t.status === "published") counts.published++;
    else if (t.status === "failed") counts.failed++;
  }
  if (counts.inFlight > 0) return;
  if (counts.pending > 0) {
    // Nothing is actually in flight at a platform — every remaining target is
    // waiting on a retry. Demote back to "scheduled" so the post stays
    // editable/cancellable instead of locked in "publishing" (a post stuck
    // there previously needed manual DB surgery to recover, 2026-08-05).
    await supabase
      .from("social_posts")
      .update({ status: "scheduled" })
      .eq("id", postId)
      .eq("status", "publishing");
    return;
  }

  const status =
    counts.published === 0 ? "failed" : counts.failed === 0 ? "published" : "partial";
  await supabase
    .from("social_posts")
    .update({
      status,
      published_at: counts.published > 0 ? new Date().toISOString() : null,
      error:
        status === "failed" ? "All platform publishes failed — see per-platform errors" : null,
    })
    .eq("id", postId)
    .eq("status", "publishing");
}

export async function runSocialTick(
  supabase: AdminClient,
  opts: { metricsOnly?: boolean; postId?: string; metricsForce?: boolean } = {}
): Promise<SocialTickSummary> {
  const summary: SocialTickSummary = {
    postsDue: 0,
    targetsPublished: 0,
    targetsProcessing: 0,
    targetsFailed: 0,
    metricsRefreshed: 0,
    errors: [],
  };
  const nowIso = new Date().toISOString();

  if (!opts.metricsOnly) {
    // 1. Promote due scheduled posts → publishing.
    let dueQuery = supabase
      .from("social_posts")
      .select("id")
      .eq("status", "scheduled")
      .lte("scheduled_at", nowIso);
    if (opts.postId) dueQuery = dueQuery.eq("id", opts.postId);
    const { data: due } = await dueQuery;
    if (due?.length) {
      summary.postsDue = due.length;
      await supabase
        .from("social_posts")
        .update({ status: "publishing" })
        .in("id", due.map((p) => p.id));
    }

    // 2. Work every in-flight target of every publishing post.
    let targetQuery = supabase
      .from("social_post_targets")
      .select("*, post:social_posts!inner(*), account:social_accounts(*)")
      .in("status", ["pending", "publishing", "processing"])
      .eq("post.status", "publishing");
    if (opts.postId) targetQuery = targetQuery.eq("post_id", opts.postId);
    const { data: targets, error: targetsError } = await targetQuery;
    if (targetsError) summary.errors.push(`load targets: ${targetsError.message}`);

    // Carousel slides, batched once for every carousel post in this tick.
    const carouselPostIds = Array.from(
      new Set(
        (targets || [])
          .filter((t) => (t as { post: SocialPost }).post?.post_type === "carousel")
          .map((t) => (t as { post_id: string }).post_id)
      )
    );
    const mediaByPost = new Map<string, SocialMedia[]>();
    if (carouselPostIds.length) {
      const { data: mediaRows } = await supabase
        .from("social_post_media")
        .select("*")
        .in("post_id", carouselPostIds)
        .order("position", { ascending: true });
      for (const m of mediaRows || []) {
        mediaByPost.set(m.post_id, [...(mediaByPost.get(m.post_id) || []), m]);
      }
    }

    type LoadedTarget = SocialTarget & {
      post: SocialPost;
      account: SocialAccount | null;
    };
    const targetsByPost = new Map<string, LoadedTarget[]>();
    for (const row of targets || []) {
      const target = row as unknown as LoadedTarget;
      targetsByPost.set(target.post_id, [...(targetsByPost.get(target.post_id) || []), target]);
    }

    const tallyStep = (step: PublishStep) => {
      if (step.state === "published") summary.targetsPublished++;
      else if (step.state === "processing") summary.targetsProcessing++;
      else summary.targetsFailed++;
    };

    const workTarget = async (loadedTarget: LoadedTarget): Promise<void> => {
      let target = loadedTarget;
      // These change after a YouTube session is durably saved. If its immediate
      // chunk upload fails, the catch path must preserve `processing` and the
      // session ref instead of treating it like a new pending attempt.
      let failureTarget: SocialTarget = target;
      let failureAttemptsDelta = 1;
      try {
        // Repair impossible-but-dangerous state before doing anything else.
        // This also makes the anti-duplicate guard effective if an earlier DB
        // update saved external_id but failed before saving status.
        if (target.external_id) {
          await applyStep(
            supabase,
            target,
            {
              state: "published",
              externalId: target.external_id,
              externalUrl:
                target.external_url ||
                (target.platform === "youtube"
                  ? `https://www.youtube.com/shorts/${target.external_id}`
                  : null),
            },
            0
          );
          summary.targetsPublished++;
          return;
        }

        // `publishing` is a short lease used only while a worker is creating a
        // new platform upload. A live lease means another tick owns it; a stale
        // one is recovered using the presence of durable platform state.
        if (target.status === "publishing") {
          const leaseAge = Date.now() - new Date(target.updated_at).getTime();
          if (leaseAge <= TARGET_LEASE_MS) return;
          const recoveredStatus =
            Object.keys((target.platform_ref || {}) as Record<string, unknown>).length > 0
              ? "processing"
              : "pending";
          const { data: recovered, error: recoverError } = await supabase
            .from("social_post_targets")
            .update({ status: recoveredStatus, error: null })
            .eq("id", target.id)
            .eq("status", "publishing")
            .eq("updated_at", target.updated_at)
            .select("id")
            .maybeSingle();
          if (recoverError) throw new Error(`Could not recover stale target lease: ${recoverError.message}`);
          if (!recovered) return;
          target = {
            ...target,
            status: recoveredStatus,
            updated_at: new Date().toISOString(),
          };
          failureTarget = target;
        }
        // Carousels have no YouTube analogue — park the target as skipped
        // instead of failing the whole post.
        if (target.post.post_type === "carousel" && target.platform === "youtube") {
          await supabase
            .from("social_post_targets")
            .update({ status: "skipped", error: null })
            .eq("id", target.id);
          return;
        }
        if (!target.account) {
          await applyStep(
            supabase,
            target,
            { state: "failed", error: "Connected account was removed" },
            1
          );
          summary.targetsFailed++;
          return;
        }

        // Claim a not-yet-started target atomically. Concurrent manual/cron
        // ticks may load the same pending rows, but only one may call a
        // platform's create-upload endpoint.
        if (target.status === "pending") {
          const { data: claimed, error: claimError } = await supabase
            .from("social_post_targets")
            .update({ status: "publishing", error: null })
            .eq("id", target.id)
            .eq("status", "pending")
            .select("id")
            .maybeSingle();
          if (claimError) throw new Error(`Could not claim pending target: ${claimError.message}`);
          if (!claimed) return;
        }

        let step: PublishStep;
        let attemptsDelta = 0;
        if (target.status === "pending") {
          attemptsDelta = 1;
          step = await beginPublish(
            target.post,
            target,
            target.account,
            mediaByPost.get(target.post_id) || []
          );
        } else {
          // Give up on zombies stuck in platform processing.
          const age = Date.now() - new Date(target.updated_at).getTime();
          step =
            age > PROCESSING_DEADLINE_MS
              ? { state: "failed", error: "Platform processing timed out" }
              : await continuePublish(target, target.account);
        }
        await applyStep(supabase, target, step, attemptsDelta);

        // YouTube session creation is deliberately metadata-only. Once its ref
        // is durable, upload the chunks immediately in this same publish call;
        // a later tick can still resume safely from Google's accepted offset.
        if (
          target.platform === "youtube" &&
          target.status === "pending" &&
          step.state === "processing"
        ) {
          const persistedTarget: SocialTarget = {
            ...target,
            status: "processing",
            platform_ref: step.ref as never,
            attempts: target.attempts + attemptsDelta,
            updated_at: new Date().toISOString(),
          };
          failureTarget = persistedTarget;
          // Session creation and its first chunk transfer are one attempt.
          failureAttemptsDelta = 0;
          step = await continuePublish(persistedTarget, target.account);
          await applyStep(supabase, persistedTarget, step, 0);
        }
        tallyStep(step);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        summary.errors.push(`target ${target.id}: ${message}`);
        try {
          const retryableYouTube =
            failureTarget.platform === "youtube" && failureTarget.status === "processing";
          const retryingYouTube =
            retryableYouTube &&
            failureTarget.attempts + failureAttemptsDelta < MAX_ATTEMPTS;
          await applyStep(
            supabase,
            failureTarget,
            {
              state: "failed",
              error: message,
              // Transport/session failures can resume from Google's accepted
              // offset. Never throw away a persisted YouTube session early.
              retryable: retryableYouTube,
            },
            failureAttemptsDelta
          );
          if (retryingYouTube) summary.targetsProcessing++;
          else summary.targetsFailed++;
        } catch {
          // row update failed too — leave for next tick
        }
      }
    };

    // Different scheduled posts stay bounded, but every platform belonging to
    // one post fans out together. A slow Meta API can no longer keep the other
    // targets locally pending.
    for (const [postId, postTargets] of targetsByPost) {
      await Promise.all(postTargets.map(workTarget));
      await rollupPost(supabase, postId);
    }
  }

  // 4. Refresh performance numbers on recently published targets.
  try {
    const metrics = await refreshDueMetrics(supabase, { force: Boolean(opts.metricsForce) });
    summary.metricsRefreshed = metrics.refreshed;
    summary.errors.push(...metrics.errors);
  } catch (e) {
    summary.errors.push(`metrics: ${e instanceof Error ? e.message : String(e)}`);
  }

  return summary;
}
