import type { Tables } from "@/types/database";

export type SocialAccount = Tables<"social_accounts">;
export type SocialPost = Tables<"social_posts">;
export type SocialTarget = Tables<"social_post_targets">;
export type SocialMetric = Tables<"social_metrics">;
export type SocialMedia = Tables<"social_post_media">;

/** Image posts: 1 slide = a single feed photo, 2–10 = a carousel (IG's cap).
 *  Both shapes share the 'carousel' post_type — the slide count decides. */
export const CAROUSEL_MIN_SLIDES = 1;
export const CAROUSEL_MAX_SLIDES = 10;
/** Platforms that can take a carousel — YouTube has no analogue and gets skipped. */
export const CAROUSEL_PLATFORMS: SocialPlatform[] = ["instagram", "facebook"];

export type SocialPlatform = SocialAccount["platform"];

/** What a platform publish step reports back to the publisher engine. */
export type PublishStep =
  | { state: "processing"; ref: Record<string, unknown> } // platform still ingesting; carry ref to next tick
  | { state: "published"; externalId: string; externalUrl: string | null }
  | { state: "failed"; error: string; retryable?: boolean };

/** Normalized per-video performance numbers; raw platform payload kept alongside. */
export interface MetricSnapshot {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  reach: number;
  raw: Record<string, unknown>;
}

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  instagram: "Instagram Reels",
  facebook: "Facebook Reels",
  youtube: "YouTube Shorts",
};
