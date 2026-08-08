/**
 * YouTube Data API v3 client — Shorts are just regular uploads that happen to
 * be vertical and ≤3 minutes; YouTube classifies them automatically.
 *
 * Auth model: one offline refresh_token per channel (Google OAuth with
 * access_type=offline). Access tokens are minted per tick and never stored.
 *
 * Upload path: unlike Meta, YouTube won't pull from a URL. We persist the
 * resumable session URI before sending bytes, then copy the hosted video in
 * small Content-Range chunks. A later tick can ask Google which bytes landed
 * and resume without creating another video.
 */
import type { MetricSnapshot } from "./types";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YT = "https://www.googleapis.com/youtube/v3";
const YT_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
/** YouTube requires chunk sizes to be multiples of 256 KiB. */
export const YT_UPLOAD_CHUNK_SIZE = 8 * 1024 * 1024;

export interface YouTubeUploadRef {
  youtube_upload_url: string;
  video_url: string;
  content_length: number;
  content_type: string;
}

export function googleOAuthConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleAuthorizeUrl(redirectUri: string, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set(
    "scope",
    // force-ssl is what unlocks captions.download, so agents can work from a
    // video's real transcript, not just its title. Adding a scope means an
    // already-connected channel must reconnect before it takes effect
    // (prompt=consent below re-mints the refresh token with the new scope).
    [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly",
      "https://www.googleapis.com/auth/youtube.force-ssl",
    ].join(" ")
  );
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent"); // force refresh_token on re-connect
  url.searchParams.set("state", state);
  return url.toString();
}

export async function googleExchangeCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string | null }> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    error_description?: string;
  };
  if (!data.access_token) throw new Error(data.error_description || "Google code exchange failed");
  return { accessToken: data.access_token, refreshToken: data.refresh_token || null };
}

export async function googleRefreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(data.error_description || "YouTube token refresh failed — reconnect the channel");
  }
  return data.access_token;
}

export async function ytOwnChannel(
  accessToken: string
): Promise<{ id: string; title: string; customUrl: string | null; thumbnail: string | null }> {
  const url = new URL(`${YT}/channels`);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("mine", "true");
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: { title?: string; customUrl?: string; thumbnails?: { default?: { url?: string } } };
    }>;
    error?: { message?: string };
  };
  const ch = data.items?.[0];
  if (!ch) throw new Error(data.error?.message || "No YouTube channel on this Google account");
  return {
    id: ch.id,
    title: ch.snippet?.title || "YouTube channel",
    customUrl: ch.snippet?.customUrl || null,
    thumbnail: ch.snippet?.thumbnails?.default?.url || null,
  };
}

function youtubeVideoResult(data: unknown): { videoId: string; url: string } | null {
  const videoId = (data as { id?: unknown } | null)?.id;
  return typeof videoId === "string" && videoId
    ? { videoId, url: `https://www.youtube.com/shorts/${videoId}` }
    : null;
}

async function youtubeError(res: Response, prefix: string, parsed?: unknown): Promise<Error> {
  const data = (parsed ?? (await res.json().catch(() => ({})))) as {
    error?: { message?: string };
  };
  return new Error(`${prefix}: ${data.error?.message || `HTTP ${res.status}`}`);
}

/** Open a resumable session without sending video bytes. Persist the returned
 * ref before calling ytResumeVideoUpload so a failed tick cannot create a
 * second upload session. */
export async function ytStartVideoUpload(
  accessToken: string,
  opts: { videoUrl: string; title: string; description: string }
): Promise<YouTubeUploadRef> {
  const source = await fetch(opts.videoUrl, { method: "HEAD" });
  if (!source.ok) {
    throw new Error(`Could not read video from storage (HTTP ${source.status})`);
  }
  const contentLength = source.headers.get("content-length");
  if (!contentLength) throw new Error("Storage did not report a video size");
  const size = Number(contentLength);
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Storage reported an invalid video size");
  const contentType = source.headers.get("content-type")?.split(";", 1)[0] || "video/mp4";

  // Session init: metadata only. Title caps at 100 chars on YouTube.
  const initRes = await fetch(
    `${YT_UPLOAD}?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(size),
        "X-Upload-Content-Type": contentType,
      },
      body: JSON.stringify({
        snippet: {
          title: opts.title.slice(0, 100) || "Short",
          description: opts.description.slice(0, 5000),
          categoryId: "22", // People & Blogs
        },
        status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
      }),
    }
  );
  if (!initRes.ok) throw await youtubeError(initRes, "YouTube upload init failed");
  const uploadUrl = initRes.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return a resumable upload URL");

  return {
    youtube_upload_url: uploadUrl,
    video_url: opts.videoUrl,
    content_length: size,
    content_type: contentType,
  };
}

/** Google answers an empty Content-Range probe with 308 + Range while an
 * upload is incomplete, or the final video resource if it already completed. */
async function ytUploadedOffset(
  accessToken: string,
  ref: YouTubeUploadRef
): Promise<{ offset: number; completed: { videoId: string; url: string } | null }> {
  const res = await fetch(ref.youtube_upload_url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Length": "0",
      "Content-Range": `bytes */${ref.content_length}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    const completed = youtubeVideoResult(data);
    if (completed) return { offset: ref.content_length, completed };
  }
  if (res.status !== 308) {
    throw await youtubeError(res, "YouTube upload status check failed", data);
  }
  const range = res.headers.get("range");
  const match = range?.match(/bytes=0-(\d+)/i);
  const offset = match ? Number(match[1]) + 1 : 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > ref.content_length) {
    throw new Error("YouTube returned an invalid resumable upload offset");
  }
  return { offset, completed: null };
}

/** Resume a persisted YouTube session. Each worker request buffers at most one
 * 8 MiB chunk; retries always probe the server-side offset first. */
export async function ytResumeVideoUpload(
  accessToken: string,
  ref: YouTubeUploadRef
): Promise<{ videoId: string; url: string }> {
  if (
    !ref.youtube_upload_url ||
    !ref.video_url ||
    !Number.isSafeInteger(ref.content_length) ||
    ref.content_length < 1
  ) {
    throw new Error("YouTube upload session data is incomplete");
  }

  const status = await ytUploadedOffset(accessToken, ref);
  if (status.completed) return status.completed;

  for (let offset = status.offset; offset < ref.content_length; ) {
    const end = Math.min(offset + YT_UPLOAD_CHUNK_SIZE, ref.content_length) - 1;
    const source = await fetch(ref.video_url, {
      headers: { Range: `bytes=${offset}-${end}` },
    });
    if (!source.ok) {
      throw new Error(`Could not read video chunk from storage (HTTP ${source.status})`);
    }
    const bytes = await source.arrayBuffer();
    const expected = end - offset + 1;
    if (bytes.byteLength !== expected) {
      throw new Error(`Storage returned ${bytes.byteLength} bytes for a ${expected}-byte video chunk`);
    }

    const putRes = await fetch(ref.youtube_upload_url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Length": String(bytes.byteLength),
        "Content-Type": ref.content_type || "video/mp4",
        "Content-Range": `bytes ${offset}-${end}/${ref.content_length}`,
      },
      body: bytes,
    });
    const data = await putRes.json().catch(() => ({}));
    if (putRes.ok) {
      const completed = youtubeVideoResult(data);
      if (completed) return completed;
      throw new Error("YouTube accepted the final chunk but did not return a video id");
    }
    if (putRes.status !== 308) throw await youtubeError(putRes, "YouTube upload failed", data);

    const accepted = putRes.headers.get("range")?.match(/bytes=0-(\d+)/i);
    const nextOffset = accepted ? Number(accepted[1]) + 1 : end + 1;
    if (!Number.isSafeInteger(nextOffset) || nextOffset <= offset || nextOffset > ref.content_length) {
      throw new Error("YouTube did not advance the resumable upload offset");
    }
    offset = nextOffset;
  }

  // Defensive: the last response should carry the video resource, but querying
  // once more avoids opening a new session if Google finalized asynchronously.
  const finalStatus = await ytUploadedOffset(accessToken, ref);
  if (finalStatus.completed) return finalStatus.completed;
  throw new Error("YouTube upload finished sending bytes but is not finalized yet");
}

export async function ytFetchMetrics(
  accessToken: string,
  videoId: string
): Promise<MetricSnapshot> {
  const url = new URL(`${YT}/videos`);
  url.searchParams.set("part", "statistics");
  url.searchParams.set("id", videoId);
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as {
    items?: Array<{
      statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
    }>;
    error?: { message?: string };
  };
  if (data.error) throw new Error(data.error.message || "YouTube stats fetch failed");
  const s = data.items?.[0]?.statistics;
  return {
    views: Number(s?.viewCount || 0),
    likes: Number(s?.likeCount || 0),
    comments: Number(s?.commentCount || 0),
    shares: 0,
    saves: 0,
    reach: 0,
    raw: { statistics: s || null },
  };
}
