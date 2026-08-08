/**
 * Performance snapshots. Each refresh appends a social_metrics row per
 * target (never updates in place) so the dashboard can chart growth, not
 * just show the latest number.
 *
 * Cadence: targets published in the last 30 days whose newest snapshot is
 * older than 6 hours, capped per tick to stay inside API rate limits.
 */
import type { AdminClient } from "@/lib/crm/types";
import type { MetricSnapshot, SocialAccount, SocialTarget } from "./types";
import { fbFetchMetrics, fbFetchPostMetrics, igFetchMetrics } from "./meta";
import { googleRefreshAccessToken, ytFetchMetrics } from "./youtube";

const SNAPSHOT_STALE_MS = 6 * 60 * 60 * 1000;
const TRACK_WINDOW_DAYS = 30;
const MAX_PER_TICK = 25;

export async function refreshDueMetrics(
  supabase: AdminClient,
  opts: { force?: boolean } = {}
): Promise<{ refreshed: number; errors: string[] }> {
  const errors: string[] = [];
  const windowStart = new Date(Date.now() - TRACK_WINDOW_DAYS * 86400000).toISOString();
  const { data: targets } = await supabase
    .from("social_post_targets")
    .select("*, account:social_accounts(*), post:social_posts(post_type)")
    .eq("status", "published")
    .not("external_id", "is", null)
    .gte("published_at", windowStart)
    .order("published_at", { ascending: false })
    .limit(100);
  if (!targets?.length) return { refreshed: 0, errors };

  // Latest snapshot per target in one query.
  const ids = targets.map((t) => t.id);
  const { data: snapshots } = await supabase
    .from("social_metrics")
    .select("target_id, captured_at")
    .in("target_id", ids)
    .order("captured_at", { ascending: false });
  const latest = new Map<string, string>();
  for (const s of snapshots || []) {
    if (!latest.has(s.target_id)) latest.set(s.target_id, s.captured_at);
  }

  // force: a human asked for fresh numbers now (studio refresh), so skip the
  // staleness gate rather than making them wait out the snapshot interval.
  const due = opts.force
    ? targets
    : targets.filter((t) => {
        const last = latest.get(t.id);
        return !last || Date.now() - new Date(last).getTime() > SNAPSHOT_STALE_MS;
      });

  // One YouTube access token per channel per run.
  const ytTokens = new Map<string, string>();
  let refreshed = 0;

  for (const row of due.slice(0, MAX_PER_TICK)) {
    const target = row as unknown as SocialTarget & {
      account: SocialAccount | null;
      post: { post_type: "video" | "carousel" } | null;
    };
    const account = target.account;
    if (!account || !target.external_id) continue;
    try {
      let snap: MetricSnapshot;
      if (target.platform === "instagram") {
        snap = await igFetchMetrics(target.external_id, account.access_token || "");
      } else if (target.platform === "facebook") {
        // Carousels land as multi-photo feed posts, which have no video_insights.
        snap =
          target.post?.post_type === "carousel"
            ? await fbFetchPostMetrics(target.external_id, account.access_token || "")
            : await fbFetchMetrics(target.external_id, account.access_token || "");
      } else {
        let token = ytTokens.get(account.id);
        if (!token) {
          if (!account.refresh_token) continue;
          token = await googleRefreshAccessToken(account.refresh_token);
          ytTokens.set(account.id, token);
        }
        snap = await ytFetchMetrics(token, target.external_id);
      }
      await supabase.from("social_metrics").insert({
        target_id: target.id,
        views: snap.views,
        likes: snap.likes,
        comments: snap.comments,
        shares: snap.shares,
        saves: snap.saves,
        reach: snap.reach,
        raw: snap.raw as never,
      });
      refreshed++;
    } catch (e) {
      // Insights lag behind publishing (IG often 404s for the first hour), so
      // a miss is not fatal — but it must be VISIBLE. Swallowing these silently
      // hid a completely dead metrics pipeline for days (2026-08-06).
      errors.push(
        `metrics ${target.platform}/${target.external_id}: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  }
  return { refreshed, errors };
}
