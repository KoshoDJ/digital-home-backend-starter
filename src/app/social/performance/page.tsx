'use client';

/**
 * Social performance — how the short-form engine is doing. Latest snapshot
 * per platform target, rolled up across the last 30 days, with a per-post
 * leaderboard underneath.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  EmptyState,
  fmtDate,
  GhostBtn,
  Loading,
  PageHeader,
  useToast,
} from '@/components/crm/kit';
import {
  type Platform,
  type PostRow,
  fmtCount,
  PLATFORM_META,
  PlatformBadge,
  postMetric,
  SocialNav,
} from '../social-kit';

const WINDOW_DAYS = 30;

export default function SocialPerformancePage() {
  const { show, node: toastNode } = useToast();
  const [posts, setPosts] = useState<PostRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [windowStart] = useState(() => Date.now() - WINDOW_DAYS * 86400000);

  const load = useCallback(async () => {
    try {
      const { posts } = await api<{ posts: PostRow[] }>('/api/social/posts?limit=200');
      setPosts(posts);
    } catch (e) {
      show(e instanceof Error ? e.message : 'Failed to load', 'err');
      setPosts([]);
    }
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await api<{ metricsRefreshed: number }>('/api/social/tick', {
        method: 'POST',
        body: JSON.stringify({ metricsOnly: true }),
      });
      show(`Pulled fresh numbers for ${res.metricsRefreshed} videos`);
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Refresh failed', 'err');
    } finally {
      setRefreshing(false);
    }
  };

  const published = useMemo(() => {
    return (posts || [])
      .filter(
        (p) =>
          ['published', 'partial'].includes(p.status) &&
          p.published_at &&
          new Date(p.published_at).getTime() > windowStart
      )
      .sort((a, b) => postMetric(b, 'views') - postMetric(a, 'views'));
  }, [posts, windowStart]);

  const totals = useMemo(() => {
    const t = { views: 0, likes: 0, comments: 0, posts: published.length };
    const perPlatform: Record<Platform, { views: number; posts: number }> = {
      instagram: { views: 0, posts: 0 },
      facebook: { views: 0, posts: 0 },
      youtube: { views: 0, posts: 0 },
    };
    for (const p of published) {
      t.views += postMetric(p, 'views');
      t.likes += postMetric(p, 'likes');
      t.comments += postMetric(p, 'comments');
      for (const target of p.targets) {
        if (target.status !== 'published') continue;
        perPlatform[target.platform].posts++;
        perPlatform[target.platform].views += target.latest_metrics?.views || 0;
      }
    }
    return { ...t, perPlatform };
  }, [published]);

  if (posts === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Social" />
        <SocialNav />
        <Loading />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="Social">
        <span className="text-xs text-minimal-muted">Last {WINDOW_DAYS} days</span>
        <GhostBtn onClick={refresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh metrics'}
        </GhostBtn>
      </PageHeader>
      <SocialNav />

      <div className="flex-1 overflow-y-auto px-12 py-8">
        {/* totals */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          {[
            { label: 'Views', value: fmtCount(totals.views) },
            { label: 'Likes', value: fmtCount(totals.likes) },
            { label: 'Comments', value: fmtCount(totals.comments) },
            { label: 'Posts published', value: String(totals.posts) },
          ].map((tile) => (
            <div key={tile.label} className="border border-minimal-border rounded-xl px-5 py-4">
              <div className="text-[12px] text-zinc-500 mb-1">{tile.label}</div>
              <div className="text-xl font-semibold text-white">{tile.value}</div>
            </div>
          ))}
        </div>

        {/* per-platform */}
        <div className="grid grid-cols-3 gap-4 mb-10">
          {(Object.keys(totals.perPlatform) as Platform[]).map((platform) => {
            const row = totals.perPlatform[platform];
            return (
              <div
                key={platform}
                className="border border-minimal-border rounded-xl px-5 py-4 flex items-center gap-4"
              >
                <PlatformBadge platform={platform} />
                <span className="text-[13px] text-zinc-400 flex-1">
                  {PLATFORM_META[platform].label}
                </span>
                <span className="text-[13px] text-white font-semibold">
                  {fmtCount(row.views)} views
                </span>
                <span className="text-[12px] text-zinc-500">{row.posts} posts</span>
              </div>
            );
          })}
        </div>

        {/* leaderboard */}
        <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Top posts</h2>
        {published.length === 0 ? (
          <EmptyState
            title="No published posts in the window"
            hint="Numbers land here once the engine publishes something and pulls its first snapshot (insights can lag an hour after publish)."
          />
        ) : (
          <div className="border border-minimal-border rounded-xl overflow-hidden mb-12">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-minimal-border text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className="px-4 py-2.5 font-semibold">Post</th>
                  <th className="px-4 py-2.5 font-semibold">Published</th>
                  <th className="px-4 py-2.5 font-semibold">Platforms</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Views</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Likes</th>
                  <th className="px-4 py-2.5 font-semibold text-right">Comments</th>
                </tr>
              </thead>
              <tbody>
                {published.map((p) => (
                  <tr key={p.id} className="border-b border-minimal-border/60 last:border-0 hover:bg-minimal-row/50">
                    <td className="px-4 py-3 text-white max-w-[320px]">
                      <span className="block truncate">
                        {p.title || p.caption.split('\n')[0] || 'Untitled'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-zinc-500 whitespace-nowrap">
                      {fmtDate(p.published_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-3">
                        {p.targets
                          .filter((t) => t.status === 'published')
                          .map((t) =>
                            t.external_url ? (
                              <a
                                key={t.id}
                                href={t.external_url}
                                target="_blank"
                                rel="noreferrer"
                                title={`${PLATFORM_META[t.platform].label}: ${fmtCount(
                                  t.latest_metrics?.views || 0
                                )} views`}
                                className="hover:opacity-70 transition-opacity"
                              >
                                <PlatformBadge platform={t.platform} />
                              </a>
                            ) : (
                              <PlatformBadge key={t.id} platform={t.platform} muted />
                            )
                          )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-white font-medium">
                      {fmtCount(postMetric(p, 'views'))}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400">
                      {fmtCount(postMetric(p, 'likes'))}
                    </td>
                    <td className="px-4 py-3 text-right text-zinc-400">
                      {fmtCount(postMetric(p, 'comments'))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
