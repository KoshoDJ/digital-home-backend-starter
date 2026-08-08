import type { SocialPlatform } from "./types";

/**
 * Per-platform post-length caps, enforced both client-side (composer) and
 * server-side (create/edit API, publish engine). Values are each platform's
 * documented hard limit — going over gets the request rejected by their API,
 * so we reject earlier with a clearer error instead of burning a publish
 * attempt (and, for IG/FB, a half-created media container).
 *
 * Instagram: https://help.instagram.com/369001149843369 (2,200 chars)
 * Facebook Reels: same 2,200-char caption cap as Instagram
 * YouTube: https://support.google.com/youtube/answer/57404 (title 100,
 *   description 5,000)
 */
export const CAPTION_LIMITS: Record<SocialPlatform, number> = {
  instagram: 2200,
  facebook: 2200,
  youtube: 5000,
};

/** Only YouTube has a separate title field; the others fold the "title" into the caption. */
export const TITLE_LIMITS: Partial<Record<SocialPlatform, number>> = {
  youtube: 100,
};

/** The tightest caption cap across all platforms — what a not-yet-targeted composer should assume. */
export const CAPTION_LIMIT = Math.min(...Object.values(CAPTION_LIMITS));

export interface LengthViolation {
  platform: SocialPlatform;
  field: "caption" | "title";
  limit: number;
  length: number;
}

/**
 * Checks a caption/title pair against every given platform's limits.
 * `platforms` should be the set of platforms a post is actually targeting —
 * an empty caption is always fine (nothing to publish yet).
 */
export function checkLengthLimits(
  platforms: SocialPlatform[],
  { caption, title }: { caption: string; title?: string | null }
): LengthViolation[] {
  const violations: LengthViolation[] = [];
  for (const platform of platforms) {
    const captionLimit = CAPTION_LIMITS[platform];
    if (caption.length > captionLimit) {
      violations.push({ platform, field: "caption", limit: captionLimit, length: caption.length });
    }
    const titleLimit = TITLE_LIMITS[platform];
    if (titleLimit && title && title.length > titleLimit) {
      violations.push({ platform, field: "title", limit: titleLimit, length: title.length });
    }
  }
  return violations;
}

export function formatLengthViolations(violations: LengthViolation[]): string {
  return violations
    .map((v) => `${v.platform} ${v.field} is ${v.length} chars (max ${v.limit})`)
    .join("; ");
}
