/**
 * R2 multipart upload plumbing for social media files.
 *
 * The browser (or CLI) uploads through our own API in ~40MB parts — no
 * third-party size caps, no CORS, no bytes buffered longer than one part.
 * The create route authenticates properly, then mints a scoped token so the
 * part/complete calls don't have to HMAC-sign multi-megabyte binary bodies.
 */
import { createHmac, timingSafeEqual } from "crypto";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AdminClient } from "@/lib/crm/types";

/** Parts must be ≥5MB (R2 rule, except the last); 40MB keeps request bodies
 *  comfortably inside Workers' per-request limit. */
export const PART_SIZE = 40 * 1024 * 1024;
export const UPLOAD_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;

export const ALLOWED_UPLOAD_TYPES = [
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "image/jpeg",
  "image/png",
  "image/webp",
];

export function socialBucket(): R2Bucket {
  const bucket = getCloudflareContext().env.SOCIAL_MEDIA;
  if (!bucket) throw new Error("SOCIAL_MEDIA R2 binding is not configured");
  return bucket;
}

export function publicMediaUrl(key: string): string {
  const base = process.env.R2_PUBLIC_BASE;
  if (!base) {
    throw new Error(
      "R2_PUBLIC_BASE is not set — point it at the public domain attached to your social-media R2 bucket (e.g. https://media.yourdomain.com)"
    );
  }
  return `${base.replace(/\/$/, "")}/${key}`;
}

/**
 * Best-effort media object deletion. New objects live in R2; posts created
 * before the R2 move still point at the legacy Supabase social-videos
 * bucket, so both stores get tried — deleting a nonexistent key is a no-op
 * in each.
 */
export async function deleteMediaObjects(supabase: AdminClient, paths: string[]): Promise<void> {
  if (!paths.length) return;
  try {
    await socialBucket().delete(paths);
  } catch {
    // no R2 binding (local dev) or transient failure — dangling objects are harmless
  }
  try {
    await supabase.storage.from("social-videos").remove(paths);
  } catch {
    // legacy bucket cleanup is best-effort
  }
}

function tokenSecret(): string {
  const secret = process.env.API_REQUEST_SIGNING_SECRET || process.env.API_SECRET_KEY;
  if (!secret) throw new Error("No signing secret configured");
  return secret;
}

export function mintUploadToken(key: string, uploadId: string): { token: string; expiry: number } {
  const expiry = Date.now() + UPLOAD_TOKEN_TTL_MS;
  const token = createHmac("sha256", tokenSecret())
    .update(`${key}:${uploadId}:${expiry}`)
    .digest("hex");
  return { token, expiry };
}

export function verifyUploadToken(
  key: string,
  uploadId: string,
  expiry: number,
  token: string
): boolean {
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;
  const expected = createHmac("sha256", tokenSecret())
    .update(`${key}:${uploadId}:${expiry}`)
    .digest("hex");
  if (token.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(token, "utf8"));
}
