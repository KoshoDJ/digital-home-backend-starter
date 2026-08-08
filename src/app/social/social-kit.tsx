'use client';

/**
 * Shared bits for the Social studio pages — client-side row shapes,
 * platform badges, and the section subnav. Visual language rides
 * components/crm/kit.tsx.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

// ── client-side row shapes ───────────────────────────────────────────────────

export type Platform = 'instagram' | 'facebook' | 'youtube';

export interface AccountRow {
  id: string;
  platform: Platform;
  external_id: string;
  name: string;
  username: string | null;
  status: 'active' | 'error' | 'disconnected';
  token_expires_at: string | null;
  connected_at: string;
  metadata: Record<string, unknown>;
}

export interface MetricsRow {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
  captured_at: string;
}

export interface TargetRow {
  id: string;
  post_id: string;
  account_id: string;
  platform: Platform;
  status: 'pending' | 'publishing' | 'processing' | 'published' | 'failed' | 'skipped';
  external_url: string | null;
  error: string | null;
  published_at: string | null;
  account: { id: string; platform: Platform; name: string; username: string | null } | null;
  latest_metrics: MetricsRow | null;
}

export interface MediaRow {
  id: string;
  post_id: string;
  position: number;
  kind: 'image' | 'video';
  path: string | null;
  url: string;
}

export interface PostRow {
  id: string;
  title: string | null;
  caption: string;
  post_type: 'video' | 'carousel';
  video_path: string | null;
  video_url: string | null;
  status: 'draft' | 'scheduled' | 'publishing' | 'published' | 'partial' | 'failed' | 'canceled';
  scheduled_at: string | null;
  published_at: string | null;
  error: string | null;
  created_at: string;
  targets: TargetRow[];
  media: MediaRow[];
}

// ── platform presentation ────────────────────────────────────────────────────

export const PLATFORM_META: Record<
  Platform,
  { label: string; short: string; dot: string; hint: string }
> = {
  instagram: { label: 'Instagram Reels', short: 'IG', dot: 'bg-fuchsia-400', hint: '≤3 min, 9:16' },
  facebook: { label: 'Facebook Reels', short: 'FB', dot: 'bg-blue-400', hint: '≤90 s, 9:16' },
  youtube: { label: 'YouTube Shorts', short: 'YT', dot: 'bg-red-400', hint: '≤3 min, 9:16' },
};

export const POST_STATUS_DOTS: Record<string, string> = {
  draft: 'bg-zinc-500',
  scheduled: 'bg-blue-400',
  publishing: 'bg-yellow-500',
  published: 'bg-green-500',
  partial: 'bg-orange-400',
  failed: 'bg-red-500',
  canceled: 'bg-zinc-600',
};

export const POST_STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  publishing: 'Publishing',
  published: 'Published',
  partial: 'Partial',
  failed: 'Failed',
  canceled: 'Canceled',
};

const POST_STATUS_PILLS: Record<string, string> = {
  draft: 'bg-zinc-500/15 text-zinc-400',
  scheduled: 'bg-blue-500/15 text-blue-400',
  publishing: 'bg-yellow-500/15 text-yellow-500',
  published: 'bg-green-500/15 text-green-500',
  partial: 'bg-orange-500/15 text-orange-400',
  failed: 'bg-red-500/15 text-red-400',
  canceled: 'bg-zinc-500/15 text-zinc-500',
};

/** GHL-style status pill ("Scheduled" / "Published" …) for post cards. */
export function PostStatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
        POST_STATUS_PILLS[status] || 'bg-zinc-500/15 text-zinc-400'
      }`}
    >
      {POST_STATUS_LABELS[status] || status}
    </span>
  );
}

export const TARGET_STATUS_DOTS: Record<string, string> = {
  pending: 'bg-zinc-500',
  publishing: 'bg-yellow-500',
  processing: 'bg-yellow-500',
  published: 'bg-green-500',
  failed: 'bg-red-500',
  skipped: 'bg-zinc-600',
};

export function PlatformBadge({ platform, muted }: { platform: Platform; muted?: boolean }) {
  const meta = PLATFORM_META[platform];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-wide ${
        muted ? 'text-zinc-500' : 'text-zinc-300'
      }`}
      title={meta.label}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      {meta.short}
    </span>
  );
}

export function PostTypeBadge({ type, slides }: { type: 'video' | 'carousel'; slides?: number }) {
  const label = type === 'video' ? 'Reel' : (slides ?? 2) <= 1 ? 'Photo' : 'Carousel';
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full border border-minimal-border text-[11px] font-medium text-zinc-400">
      {label}
    </span>
  );
}

export function fmtCount(n: number | null | undefined): string {
  const v = n || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}k`;
  if (v >= 1_000) return `${(v / 1000).toFixed(1)}k`;
  return String(v);
}

/** Sum a metric across a post's targets (latest snapshot each). */
export function postMetric(post: PostRow, key: keyof MetricsRow): number {
  return post.targets.reduce((s, t) => {
    const v = t.latest_metrics?.[key];
    return s + (typeof v === 'number' ? v : 0);
  }, 0);
}

// ── section subnav ───────────────────────────────────────────────────────────

const TABS = [
  { href: '/social', label: 'Studio' },
  { href: '/social/performance', label: 'Performance' },
  { href: '/social/accounts', label: 'Accounts' },
];

export function SocialNav() {
  const pathname = usePathname();
  return (
    <nav className="px-12 flex items-center gap-1 border-b border-minimal-border shrink-0">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-3.5 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              active
                ? 'border-white text-white'
                : 'border-transparent text-minimal-muted hover:text-white'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">{children}</h2>
  );
}
