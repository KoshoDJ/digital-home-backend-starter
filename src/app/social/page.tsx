'use client';

/**
 * Social studio — the short-form distribution calendar. Schedule a vertical
 * video or a multi-slide carousel once, pick platforms, and the engine
 * publishes it: videos to Instagram Reels, Facebook Reels, and YouTube
 * Shorts; carousels to Instagram and Facebook (YouTube has no analogue).
 *
 * Two views over the same posts: the month calendar, and a GHL-style list
 * with search, status, and date-range filters. The choice sticks per browser.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  EmptyState,
  Field,
  fmtDate,
  GhostBtn,
  Loading,
  Modal,
  PageHeader,
  PrimaryBtn,
  Select,
  StatusDot,
  TextArea,
  TextInput,
  useToast,
} from '@/components/crm/kit';
import {
  type AccountRow,
  type MediaRow,
  type PostRow,
  fmtCount,
  PLATFORM_META,
  PlatformBadge,
  POST_STATUS_DOTS,
  POST_STATUS_LABELS,
  postMetric,
  PostStatusPill,
  PostTypeBadge,
  SocialNav,
  TARGET_STATUS_DOTS,
} from './social-kit';

const CAPTION_LIMIT = 2200;
const MAX_SLIDES = 10;

// ── date helpers (calendar is Monday-first) ──────────────────────────────────

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')}`;
}
function monthGrid(cursor: Date): Date[] {
  const first = startOfMonth(cursor);
  const start = new Date(first);
  start.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // back to Monday
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}
/** The date a post lives under — scheduled first, then published, then created. */
function postDate(p: PostRow): string {
  return p.scheduled_at || p.published_at || p.created_at;
}
function fmtTime(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── image normalization (Instagram-legal, always JPEG) ───────────────────────

/** Instagram feed accepts 4:5 (0.8) through 1.91:1. */
const IG_MIN_RATIO = 0.8;
const IG_MAX_RATIO = 1.91;
const MAX_IMAGE_WIDTH = 1440;

/**
 * Make any picked image Instagram-legal before it ever hits storage: decode,
 * center-crop to the nearest allowed ratio if out of range (a raw phone photo
 * is 3:4 and IG rejects it), cap resolution, and re-encode as JPEG (the only
 * format IG guarantees). The preview then shows exactly what will publish.
 */
async function normalizeImage(file: File): Promise<{ blob: Blob; cropped: boolean }> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error(`${file.name} is not a readable image — use JPG or PNG`);
  const { width, height } = bitmap;
  const ratio = width / height;
  const target = ratio < IG_MIN_RATIO ? IG_MIN_RATIO : ratio > IG_MAX_RATIO ? IG_MAX_RATIO : ratio;
  let cropW = width;
  let cropH = height;
  if (ratio < target) cropH = Math.round(width / target);
  else if (ratio > target) cropW = Math.round(height * target);
  const sx = Math.round((width - cropW) / 2);
  const sy = Math.round((height - cropH) / 2);
  const scale = Math.min(1, MAX_IMAGE_WIDTH / cropW);
  const outW = Math.round(cropW * scale);
  const outH = Math.round(cropH * scale);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  canvas.getContext('2d')!.drawImage(bitmap, sx, sy, cropW, cropH, 0, 0, outW, outH);
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process the image'))), 'image/jpeg', 0.9)
  );
  return { blob, cropped: target !== ratio };
}

// ── uploads (direct browser → storage, with progress) ────────────────────────

/**
 * Multipart upload to R2 through our own API — ~40MB parts, so there's no
 * practical file-size cap and no third-party endpoints involved.
 */
async function uploadToStorage(
  file: File,
  onProgress: (pct: number) => void
): Promise<{ path: string; publicUrl: string }> {
  const init = await api<{
    key: string;
    uploadId: string;
    partSize: number;
    publicUrl: string;
    token: string;
    expiry: number;
  }>('/api/social/upload', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, contentType: file.type }),
  });

  const putPart = (part: number, chunk: Blob, uploadedSoFar: number) =>
    new Promise<string>((resolve, reject) => {
      const params = new URLSearchParams({
        key: init.key,
        uploadId: init.uploadId,
        part: String(part),
        expiry: String(init.expiry),
        token: init.token,
      });
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/social/upload/part?${params}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.min(99, Math.round(((uploadedSoFar + e.loaded) / file.size) * 100)));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve((JSON.parse(xhr.responseText) as { etag: string }).etag);
          } catch {
            reject(new Error('Upload failed — bad part response'));
          }
        } else {
          let message = `Upload failed (${xhr.status})`;
          try {
            message = (JSON.parse(xhr.responseText) as { error?: string }).error || message;
          } catch {}
          reject(new Error(message));
        }
      };
      xhr.onerror = () => reject(new Error('Upload failed — network error'));
      xhr.send(chunk);
    });

  const parts: Array<{ part: number; etag: string }> = [];
  try {
    for (let part = 1, offset = 0; offset < file.size || part === 1; part++, offset += init.partSize) {
      const chunk = file.slice(offset, offset + init.partSize);
      const etag = await putPart(part, chunk, offset);
      parts.push({ part, etag });
      if (offset + init.partSize >= file.size) break;
    }
    const done = await api<{ publicUrl: string }>('/api/social/upload/complete', {
      method: 'POST',
      body: JSON.stringify({
        key: init.key,
        uploadId: init.uploadId,
        expiry: init.expiry,
        token: init.token,
        parts,
      }),
    });
    onProgress(100);
    return { path: init.key, publicUrl: done.publicUrl };
  } catch (e) {
    // Best effort: don't leave half-uploaded parts around.
    api('/api/social/upload/complete', {
      method: 'POST',
      body: JSON.stringify({
        key: init.key,
        uploadId: init.uploadId,
        expiry: init.expiry,
        token: init.token,
        abort: true,
      }),
    }).catch(() => {});
    throw e;
  }
}

/** Read a video file's pixel dimensions in the browser (null if unreadable). */
function readVideoDims(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => {
      resolve(v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null);
      URL.revokeObjectURL(url);
    };
    v.onerror = () => {
      resolve(null);
      URL.revokeObjectURL(url);
    };
    v.src = url;
  });
}

const NORMALIZED_VIDEO_WIDTH = 1080;
const NORMALIZED_VIDEO_HEIGHT = 1920;
const TARGET_NORMALIZED_VIDEO_BYTES = 58 * 1024 * 1024;
const MAX_NORMALIZED_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_VIDEO_BITRATE = 8_000_000;

function supportedMp4RecorderType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ].find((type) => MediaRecorder.isTypeSupported(type)) || null;
}

/**
 * Browser-side video normalization for the Cloudflare-hosted studio. Workers
 * cannot run ffmpeg, so the selected file is played through a 1080x1920 canvas
 * and recorded as bounded-bitrate H.264 before any bytes reach R2. This is
 * deliberately fail-closed: uploading the raw file recreates the 413/timeout
 * incident this seam exists to prevent.
 */
async function normalizeVideo(
  file: File,
  onProgress: (pct: number) => void
): Promise<File> {
  const mimeType = supportedMp4RecorderType();
  if (!mimeType || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error(
      'This browser cannot compress video to H.264. Use current Chrome or Safari, or export a 1080×1920 H.264 MP4 under 60 MB.'
    );
  }

  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.playsInline = true;
  video.src = objectUrl;
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error(`${file.name} is not a readable video`));
  });
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !video.videoWidth || !video.videoHeight) {
    URL.revokeObjectURL(objectUrl);
    throw new Error(`${file.name} has invalid video metadata`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = NORMALIZED_VIDEO_WIDTH;
  canvas.height = NORMALIZED_VIDEO_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    URL.revokeObjectURL(objectUrl);
    throw new Error('Could not start the browser video encoder');
  }
  const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
  const drawW = Math.round(video.videoWidth * scale);
  const drawH = Math.round(video.videoHeight * scale);
  const drawX = Math.round((canvas.width - drawW) / 2);
  const drawY = Math.round((canvas.height - drawH) / 2);

  const canvasStream = canvas.captureStream(30);
  let audioContext: AudioContext | null = null;
  let outputStream: MediaStream = canvasStream;
  try {
    audioContext = new AudioContext();
    const audioSource = audioContext.createMediaElementSource(video);
    const audioOutput = audioContext.createMediaStreamDestination();
    audioSource.connect(audioOutput);
    outputStream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...audioOutput.stream.getAudioTracks(),
    ]);
  } catch {
    // Silent videos and restrictive browsers can still produce a valid MP4.
  }

  // Keep enough room for 128 kbps audio and MP4 overhead. Long Shorts receive
  // a lower ceiling so the result stays below the same safe payload limit.
  const sizeBoundBitrate = Math.floor((TARGET_NORMALIZED_VIDEO_BYTES * 8) / video.duration - 192_000);
  const videoBitsPerSecond = Math.max(1_200_000, Math.min(MAX_VIDEO_BITRATE, sizeBoundBitrate));
  const recorder = new MediaRecorder(outputStream, {
    mimeType,
    videoBitsPerSecond,
    audioBitsPerSecond: 128_000,
  });
  const chunks: Blob[] = [];
  const stopped = new Promise<void>((resolve, reject) => {
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    recorder.onerror = () => reject(new Error('The browser video encoder failed'));
    recorder.onstop = () => resolve();
  });

  let frame = 0;
  const draw = () => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, drawX, drawY, drawW, drawH);
    if (!video.ended && !video.paused) frame = requestAnimationFrame(draw);
  };

  try {
    video.ontimeupdate = () => onProgress(Math.min(99, Math.round((video.currentTime / video.duration) * 100)));
    video.onended = () => {
      cancelAnimationFrame(frame);
      if (recorder.state !== 'inactive') recorder.stop();
    };
    recorder.start(1000);
    await audioContext?.resume();
    await video.play();
    draw();
    await stopped;
  } catch (error) {
    if (recorder.state !== 'inactive') recorder.stop();
    throw error;
  } finally {
    cancelAnimationFrame(frame);
    video.pause();
    canvasStream.getTracks().forEach((track) => track.stop());
    outputStream.getTracks().forEach((track) => track.stop());
    await audioContext?.close().catch(() => {});
    URL.revokeObjectURL(objectUrl);
  }

  const blob = new Blob(chunks, { type: 'video/mp4' });
  if (!blob.size) throw new Error('The browser video encoder produced an empty file');
  if (blob.size > MAX_NORMALIZED_VIDEO_BYTES) {
    throw new Error(
      `Compressed video is ${(blob.size / 1024 / 1024).toFixed(1)} MB. Export an H.264 MP4 under 60 MB before scheduling.`
    );
  }
  const stem = file.name.replace(/\.[^.]+$/, '') || 'reel';
  onProgress(100);
  return new File([blob], `${stem}-social.mp4`, { type: 'video/mp4' });
}

function useVideoUpload(show: (t: string, k?: 'ok' | 'err') => void) {
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<'compressing' | 'uploading' | null>(null);
  const [video, setVideo] = useState<{ path: string; publicUrl: string } | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  // Kept on screen under the slot — a toast alone is easy to miss and the
  // slot resetting to "Upload video" reads as a silent failure.
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (file: File) => {
      setProgress(0);
      setError(null);
      setDims(null);
      try {
        setDims(await readVideoDims(file));
        setPhase('compressing');
        const normalized = await normalizeVideo(file, (pct) => setProgress(Math.round(pct / 2)));
        setPhase('uploading');
        setVideo(
          await uploadToStorage(normalized, (pct) => setProgress(50 + Math.round(pct / 2)))
        );
        setProgress(null);
        setPhase(null);
      } catch (e) {
        setProgress(null);
        setPhase(null);
        const message = e instanceof Error ? e.message : 'Upload failed';
        setError(message);
        show(message, 'err');
      }
    },
    [show]
  );

  return { progress, phase, video, setVideo, upload, error, dims };
}

// ── composer ─────────────────────────────────────────────────────────────────

type Slide = { path: string | null; url: string };

function Composer({
  accounts,
  editing,
  prefillDate,
  onClose,
  onSaved,
  onPublishNow,
  show,
}: {
  accounts: AccountRow[];
  editing: PostRow | null;
  prefillDate: string | null; // yyyy-mm-dd
  onClose: () => void;
  onSaved: () => void;
  onPublishNow: (postId: string) => void;
  show: (t: string, k?: 'ok' | 'err') => void;
}) {
  // Post type is chosen at creation and fixed once the post exists.
  const [postType, setPostType] = useState<'video' | 'carousel'>(editing?.post_type || 'video');
  const [title, setTitle] = useState(editing?.title || '');
  const [caption, setCaption] = useState(editing?.caption || '');
  const [when, setWhen] = useState(
    editing?.scheduled_at
      ? toLocalInput(editing.scheduled_at)
      : prefillDate
        ? `${prefillDate}T09:00`
        : ''
  );
  const [selected, setSelected] = useState<Set<string>>(
    new Set(editing?.targets.map((t) => t.account_id) || accounts.filter((a) => a.status === 'active').map((a) => a.id))
  );
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const slideInput = useRef<HTMLInputElement>(null);
  const { progress, phase: videoPhase, video, setVideo, upload, error: videoError, dims: videoDims } = useVideoUpload(show);
  const normalizationNote = videoDims
    ? `Normalized from ${videoDims.w}×${videoDims.h} to 1080×1920 H.264 before upload.`
    : null;

  const [slides, setSlides] = useState<Slide[]>(
    (editing?.media || []).map((m: MediaRow) => ({ path: m.path, url: m.url }))
  );
  const [slideStatus, setSlideStatus] = useState<string | null>(null);

  useEffect(() => {
    if (editing?.video_url && editing.video_path) {
      setVideo({ path: editing.video_path, publicUrl: editing.video_url });
    }
  }, [editing, setVideo]);

  const active = accounts.filter((a) => a.status === 'active');
  const carousel = postType === 'carousel';

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const switchType = (type: 'video' | 'carousel') => {
    if (editing) return;
    setPostType(type);
    if (type === 'carousel') {
      // YouTube can't take a carousel — drop it from the selection.
      setSelected((prev) => {
        const next = new Set(prev);
        for (const a of accounts) if (a.platform === 'youtube') next.delete(a.id);
        return next;
      });
    }
  };

  const addSlides = async (files: FileList) => {
    const room = MAX_SLIDES - slides.length;
    const list = Array.from(files).slice(0, room);
    if (files.length > room) show(`Carousels cap at ${MAX_SLIDES} slides`, 'err');
    let croppedCount = 0;
    for (let i = 0; i < list.length; i++) {
      setSlideStatus(`Uploading ${i + 1}/${list.length}…`);
      try {
        const { blob, cropped } = await normalizeImage(list[i]);
        if (cropped) croppedCount++;
        const jpegName = list[i].name.replace(/\.[^.]+$/, '') + '.jpg';
        const upload = new File([blob], jpegName, { type: 'image/jpeg' });
        const { path, publicUrl } = await uploadToStorage(upload, () => {});
        setSlides((prev) => [...prev, { path, url: publicUrl }]);
      } catch (e) {
        show(e instanceof Error ? e.message : 'Upload failed', 'err');
        break;
      }
    }
    setSlideStatus(null);
    if (croppedCount > 0) {
      show(
        `${croppedCount} image${croppedCount === 1 ? '' : 's'} auto-cropped to fit Instagram — check the previews`
      );
    }
    if (slideInput.current) slideInput.current.value = '';
  };

  const moveSlide = (i: number, dir: -1 | 1) => {
    setSlides((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const save = async (mode: 'draft' | 'scheduled' | 'now') => {
    if (mode !== 'draft') {
      if (carousel && slides.length < 1) return show('Add at least 1 photo', 'err');
      if (!carousel && !video) return show('Upload a video first', 'err');
      if (mode === 'scheduled' && !when) return show('Pick a date and time', 'err');
      if (selected.size === 0) return show('Pick at least one platform', 'err');
    }
    setBusy(true);
    try {
      const payload = {
        title: title || undefined,
        caption,
        post_type: postType,
        video_path: carousel ? undefined : video?.path,
        video_url: carousel ? undefined : video?.publicUrl,
        media: carousel
          ? slides.map((s) => ({ url: s.url, path: s.path, kind: 'image' as const }))
          : undefined,
        scheduled_at:
          mode === 'now'
            ? new Date().toISOString()
            : when
              ? new Date(when).toISOString()
              : null,
        account_ids: Array.from(selected),
        status: mode === 'draft' ? ('draft' as const) : ('scheduled' as const),
      };
      let postId = editing?.id;
      if (editing) {
        await api(`/api/social/posts/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
      } else {
        const { post } = await api<{ post: { id: string } }>('/api/social/posts', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        postId = post.id;
      }

      // Publish-now is fire-and-forget: close the composer immediately and
      // let the post card carry the Publishing → Published state.
      if (mode === 'now' && postId) {
        onSaved();
        onClose();
        onPublishNow(postId);
        return;
      }
      show(mode === 'scheduled' ? 'Scheduled ✓' : 'Draft saved');
      onSaved();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Save failed';
      if (editing && /not found/i.test(message)) {
        // The post was deleted or replaced elsewhere (another tab, the CLI):
        // a stale board is the real problem, so refresh it instead of dead-ending.
        show('This post no longer exists — the board was out of date and has been refreshed', 'err');
        onSaved();
        onClose();
      } else {
        show(message, 'err');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={editing ? 'Edit post' : 'New post'} onClose={onClose} wide>
      <div className="grid grid-cols-[220px_1fr] gap-6">
        {/* media slot */}
        <div className="flex flex-col gap-3">
          {!editing && (
            <div className="grid grid-cols-2 rounded-lg border border-minimal-border overflow-hidden">
              {(['video', 'carousel'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => switchType(t)}
                  className={`px-2 py-1.5 text-[12px] font-medium transition-colors ${
                    postType === t
                      ? 'bg-minimal-row text-white'
                      : 'text-minimal-muted hover:text-white'
                  }`}
                >
                  {t === 'video' ? 'Reel' : 'Photos'}
                </button>
              ))}
            </div>
          )}
          {editing && <PostTypeBadge type={postType} slides={slides.length} />}

          {!carousel ? (
            <>
              <input
                ref={fileInput}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
              />
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                disabled={progress !== null}
                className="w-full aspect-[9/16] border border-dashed border-minimal-border rounded-xl overflow-hidden relative hover:border-zinc-500 transition-colors bg-minimal-row"
              >
                {video ? (
                  <video
                    src={video.publicUrl}
                    className="absolute inset-0 w-full h-full object-cover"
                    muted
                    playsInline
                  />
                ) : (
                  <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-minimal-muted text-[12px] px-4">
                    {progress !== null ? (
                      <>
                        <span className="font-semibold text-white">{progress}%</span>
                        <span>{videoPhase === 'compressing' ? 'Compressing…' : 'Uploading…'}</span>
                        <span className="w-24 h-1 rounded bg-minimal-border overflow-hidden">
                          <span
                            className="block h-full bg-white transition-[width]"
                            style={{ width: `${progress}%` }}
                          />
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="text-lg">⬆</span>
                        Upload video
                        <span className="text-zinc-600">MP4 · 9:16 vertical</span>
                      </>
                    )}
                  </span>
                )}
              </button>
              {video && progress === null && (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  className="w-full text-[12px] text-minimal-muted hover:text-white transition-colors"
                >
                  Replace video
                </button>
              )}
              {videoError && (
                <p className="text-[11px] text-red-400 leading-snug">{videoError}</p>
              )}
              {!videoError && normalizationNote && (
                <p className="text-[11px] text-zinc-500 leading-snug">{normalizationNote}</p>
              )}
            </>
          ) : (
            <>
              <input
                ref={slideInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                multiple
                className="hidden"
                onChange={(e) => e.target.files?.length && addSlides(e.target.files)}
              />
              <div className="flex flex-col gap-2">
                {slides.map((s, i) => (
                  <div
                    key={`${s.url}-${i}`}
                    className="flex items-center gap-2 border border-minimal-border rounded-lg p-1.5"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={s.url}
                      alt={`Slide ${i + 1}`}
                      className="w-10 h-12 object-cover rounded shrink-0"
                    />
                    <span className="text-[11px] text-zinc-500 flex-1">Slide {i + 1}</span>
                    <button
                      type="button"
                      onClick={() => moveSlide(i, -1)}
                      disabled={i === 0}
                      className="text-zinc-500 hover:text-white disabled:opacity-30 px-1"
                      title="Move up"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSlide(i, 1)}
                      disabled={i === slides.length - 1}
                      className="text-zinc-500 hover:text-white disabled:opacity-30 px-1"
                      title="Move down"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => setSlides((prev) => prev.filter((_, j) => j !== i))}
                      className="text-zinc-500 hover:text-red-400 px-1"
                      title="Remove slide"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                {slides.length < MAX_SLIDES && (
                  <button
                    type="button"
                    onClick={() => slideInput.current?.click()}
                    disabled={slideStatus !== null}
                    className="w-full py-4 border border-dashed border-minimal-border rounded-xl text-[12px] text-minimal-muted hover:border-zinc-500 hover:text-white transition-colors"
                  >
                    {slideStatus ?? `+ Add slides · ${slides.length}/${MAX_SLIDES}`}
                  </button>
                )}
                <span className="text-[11px] text-zinc-600">
                  Images are converted to JPEG and auto-cropped to Instagram&apos;s range
                  (4:5–1.91:1) if needed — the preview is exactly what publishes. 1 slide
                  posts a single photo; 2–10 become a carousel, ordered top to bottom.
                </span>
              </div>
            </>
          )}
        </div>

        {/* fields */}
        <div className="flex flex-col gap-4">
          <Field label="Title" hint={carousel ? 'Internal label' : 'Internal label — also used as the YouTube title (100 chars)'}>
            <TextInput
              value={title}
              maxLength={100}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. 3 hooks that doubled our reach"
            />
          </Field>
          <Field label={`Caption · ${caption.length}/${CAPTION_LIMIT}`}>
            <TextArea
              value={caption}
              rows={6}
              maxLength={CAPTION_LIMIT}
              onChange={(e) => setCaption(e.target.value)}
              placeholder={
                carousel
                  ? 'The caption that goes out with the carousel…\n\n#hashtags welcome'
                  : 'The caption that goes out with the video…\n\n#hashtags welcome'
              }
            />
          </Field>
          <Field label="Platforms">
            {active.length === 0 ? (
              <p className="text-[13px] text-zinc-500">
                No accounts connected yet — head to the Accounts tab first.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {active.map((a) => {
                  const unavailable = carousel && a.platform === 'youtube';
                  return (
                    <label
                      key={a.id}
                      className={`flex items-center gap-3 px-3 py-2 border rounded-lg transition-colors ${
                        unavailable
                          ? 'border-minimal-border opacity-40 cursor-not-allowed'
                          : selected.has(a.id)
                            ? 'border-zinc-500 bg-minimal-row cursor-pointer'
                            : 'border-minimal-border hover:border-zinc-600 cursor-pointer'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={!unavailable && selected.has(a.id)}
                        disabled={unavailable}
                        onChange={() => toggle(a.id)}
                        className="accent-white"
                      />
                      <PlatformBadge platform={a.platform} />
                      <span className="text-[13px] text-zinc-300 flex-1 truncate">
                        {a.username ? `@${a.username}` : a.name}
                      </span>
                      <span className="text-[11px] text-zinc-600">
                        {unavailable ? 'No carousel format' : PLATFORM_META[a.platform].hint}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
          <Field label="Schedule for">
            <TextInput type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </Field>
          <div className="flex items-center justify-end gap-3 pt-2">
            <GhostBtn onClick={() => save('draft')} disabled={busy || progress !== null || slideStatus !== null}>
              Save draft
            </GhostBtn>
            <GhostBtn onClick={() => save('now')} disabled={busy || progress !== null || slideStatus !== null}>
              Post now
            </GhostBtn>
            <PrimaryBtn onClick={() => save('scheduled')} disabled={busy || progress !== null || slideStatus !== null}>
              {busy ? 'Saving…' : 'Schedule'}
            </PrimaryBtn>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── post detail ──────────────────────────────────────────────────────────────

function PostDetail({
  post,
  onClose,
  onEdit,
  onChanged,
  onPublishNow,
  show,
}: {
  post: PostRow;
  onClose: () => void;
  onEdit: () => void;
  onChanged: () => void;
  onPublishNow: (postId: string) => void;
  show: (t: string, k?: 'ok' | 'err') => void;
}) {
  const [busy, setBusy] = useState(false);
  const [slide, setSlide] = useState(0);
  const editable = ['draft', 'scheduled', 'canceled', 'failed'].includes(post.status);
  const publishable = ['draft', 'scheduled', 'failed', 'partial', 'canceled'].includes(post.status);
  const media = post.media || [];

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      show(done);
      onChanged();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Action failed';
      if (/not found/i.test(message)) {
        // Post deleted or replaced elsewhere (another tab, the CLI) — the
        // board is stale, so refresh it instead of dead-ending on the error.
        show('This post no longer exists — the board was out of date and has been refreshed', 'err');
        onChanged();
        onClose();
      } else {
        show(message, 'err');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={post.title || 'Untitled post'} onClose={onClose} wide>
      <div
        className={`grid ${post.post_type === 'carousel' ? 'grid-cols-[280px_1fr]' : 'grid-cols-[180px_1fr]'} gap-6`}
      >
        <div className="flex flex-col gap-2">
          {post.post_type === 'carousel' ? (
            <div className="relative">
              {/* Slides are 4:5 (up to 1:1) — show them uncropped, the way IG renders them */}
              <div className="aspect-[4/5] rounded-xl overflow-hidden bg-black border border-minimal-border">
                {media[slide] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={media[slide].url}
                    alt={`Slide ${slide + 1}`}
                    className="w-full h-full object-contain"
                  />
                )}
              </div>
              {media.length > 1 && (
                <>
                  <button
                    type="button"
                    aria-label="Previous slide"
                    onClick={() => setSlide((slide - 1 + media.length) % media.length)}
                    className="absolute left-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
                  >
                    ‹
                  </button>
                  <button
                    type="button"
                    aria-label="Next slide"
                    onClick={() => setSlide((slide + 1) % media.length)}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/60 text-white flex items-center justify-center opacity-70 hover:opacity-100 transition-opacity"
                  >
                    ›
                  </button>
                  <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium">
                    {slide + 1}/{media.length}
                  </span>
                </>
              )}
            </div>
          ) : (
            <div className="aspect-[9/16] rounded-xl overflow-hidden bg-minimal-row border border-minimal-border">
              {post.video_url && (
                <video src={post.video_url} className="w-full h-full object-cover" controls playsInline />
              )}
            </div>
          )}
          {post.post_type === 'carousel' && media.length > 1 && (
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {media.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSlide(i)}
                  className={`w-8 h-10 rounded overflow-hidden border shrink-0 transition-colors ${
                    i === slide ? 'border-white' : 'border-minimal-border opacity-60 hover:opacity-100'
                  }`}
                  title={`Slide ${i + 1}`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={m.url} alt="" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-4 min-w-0">
          <div className="flex items-center gap-4">
            <StatusDot status={post.status} map={POST_STATUS_DOTS} />
            <PostTypeBadge type={post.post_type} slides={media.length} />
            <span className="text-[12px] text-zinc-500">
              {post.status === 'published' || post.status === 'partial'
                ? `Published ${fmtDate(post.published_at)}`
                : post.scheduled_at
                  ? `Scheduled ${fmtDate(post.scheduled_at)}`
                  : `Created ${fmtDate(post.created_at)}`}
            </span>
          </div>

          {post.caption && (
            <p className="text-[13px] text-zinc-400 whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto">
              {post.caption}
            </p>
          )}

          <div className="flex flex-col gap-2">
            {post.targets.map((t) => (
              <div
                key={t.id}
                className="flex items-center gap-3 px-3 py-2 border border-minimal-border rounded-lg"
              >
                <PlatformBadge platform={t.platform} />
                <StatusDot status={t.status} map={TARGET_STATUS_DOTS} />
                {t.latest_metrics && (
                  <span className="text-[12px] text-zinc-500">
                    {fmtCount(t.latest_metrics.views)} views · {fmtCount(t.latest_metrics.likes)}{' '}
                    likes · {fmtCount(t.latest_metrics.comments)} comments
                  </span>
                )}
                <span className="flex-1" />
                {t.external_url && (
                  <a
                    href={t.external_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[12px] text-zinc-400 hover:text-white underline underline-offset-2"
                  >
                    View ↗
                  </a>
                )}
                {t.error && (
                  <span className="text-[11px] text-red-400 max-w-[220px] truncate" title={t.error}>
                    {t.error}
                  </span>
                )}
              </div>
            ))}
          </div>

          {post.error && <p className="text-[12px] text-red-400">{post.error}</p>}

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            {publishable && (
              <PrimaryBtn
                disabled={busy}
                onClick={() => {
                  // Fire-and-forget: the card on the calendar carries the
                  // Publishing → Published state; a toast reports the result.
                  onClose();
                  onPublishNow(post.id);
                }}
              >
                {post.status === 'failed' || post.status === 'partial' ? 'Retry now' : 'Publish now'}
              </PrimaryBtn>
            )}
            {editable && <GhostBtn onClick={onEdit}>Edit</GhostBtn>}
            {['scheduled', 'canceled', 'failed'].includes(post.status) && (
              <GhostBtn
                disabled={busy}
                onClick={() =>
                  act(
                    () =>
                      api(`/api/social/posts/${post.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ status: 'draft' }),
                      }),
                    'Moved to draft'
                  )
                }
              >
                Move to draft
              </GhostBtn>
            )}
            {post.status === 'scheduled' && (
              <GhostBtn
                disabled={busy}
                onClick={() =>
                  act(
                    () =>
                      api(`/api/social/posts/${post.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ status: 'canceled' }),
                      }),
                    'Canceled'
                  )
                }
              >
                Cancel
              </GhostBtn>
            )}
            {post.status !== 'publishing' && (
              <GhostBtn
                danger
                disabled={busy}
                onClick={() => {
                  if (!confirm('Delete this post? Published content stays live on the platforms.')) return;
                  act(() => api(`/api/social/posts/${post.id}`, { method: 'DELETE' }), 'Deleted');
                }}
              >
                Delete
              </GhostBtn>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── list view (GHL-style planner table) ──────────────────────────────────────

function MediaThumb({ post }: { post: PostRow }) {
  const first = post.media?.[0];
  if (post.post_type === 'carousel' && first) {
    return (
      <span className="relative inline-block w-9 h-12 rounded overflow-hidden bg-minimal-row border border-minimal-border shrink-0">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={first.url} alt="" className="w-full h-full object-cover" />
        {post.media.length > 1 && (
          <span className="absolute bottom-0 right-0 px-1 text-[9px] font-semibold bg-black/70 text-white rounded-tl">
            {post.media.length}
          </span>
        )}
      </span>
    );
  }
  if (post.video_url) {
    return (
      <span className="inline-block w-9 h-12 rounded overflow-hidden bg-minimal-row border border-minimal-border shrink-0">
        <video src={post.video_url} className="w-full h-full object-cover" muted playsInline preload="metadata" />
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center w-9 h-12 rounded bg-minimal-row border border-minimal-border text-zinc-600 text-[10px] shrink-0">
      —
    </span>
  );
}

function ListView({
  posts,
  onOpen,
}: {
  posts: PostRow[];
  onOpen: (p: PostRow) => void;
}) {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return posts
      .filter((p) => {
        if (status && p.status !== status) return false;
        if (needle.length >= 3) {
          const hay = `${p.title || ''}\n${p.caption}`.toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        const d = postDate(p);
        if (from && d < from) return false;
        if (to && d > `${to}T23:59:59`) return false;
        return true;
      })
      .sort((a, b) => postDate(b).localeCompare(postDate(a)));
  }, [posts, q, status, from, to]);

  return (
    <div>
      {/* filters */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="w-64">
          <TextInput
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by caption (min 3 chars)"
          />
        </div>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
          <option value="">All statuses</option>
          {Object.entries(POST_STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
        <div className="flex items-center gap-2 text-[12px] text-zinc-500">
          <TextInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <span>→</span>
          <TextInput type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {(q || status || from || to) && (
          <GhostBtn
            onClick={() => {
              setQ('');
              setStatus('');
              setFrom('');
              setTo('');
            }}
          >
            Clear
          </GhostBtn>
        )}
        <span className="text-[12px] text-zinc-600 ml-auto">
          {rows.length} post{rows.length === 1 ? '' : 's'}
        </span>
      </div>

      {/* table */}
      {rows.length === 0 ? (
        <EmptyState title="No posts match" hint="Loosen the filters or schedule something new." />
      ) : (
        <div className="border border-minimal-border rounded-xl overflow-hidden">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-minimal-border text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-2.5 font-semibold">Caption</th>
                <th className="px-3 py-2.5 font-semibold">Media</th>
                <th className="px-3 py-2.5 font-semibold">Status</th>
                <th className="px-3 py-2.5 font-semibold">Type</th>
                <th className="px-3 py-2.5 font-semibold">Date</th>
                <th className="px-3 py-2.5 font-semibold">Social</th>
                <th className="px-3 py-2.5 font-semibold text-right">Views</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => onOpen(p)}
                  className="border-b border-minimal-border/60 last:border-b-0 cursor-pointer hover:bg-minimal-row/50 transition-colors"
                >
                  <td className="px-4 py-2.5 max-w-[320px]">
                    <span className="block text-[13px] text-white truncate">
                      {p.title || p.caption.split('\n')[0] || 'Untitled'}
                    </span>
                    {p.title && p.caption && (
                      <span className="block text-[11px] text-zinc-600 truncate">
                        {p.caption.split('\n')[0]}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <MediaThumb post={p} />
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <PostStatusPill status={p.status} />
                  </td>
                  <td className="px-3 py-2.5">
                    <PostTypeBadge type={p.post_type} slides={p.media?.length} />
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-zinc-400 whitespace-nowrap">
                    {fmtDate(postDate(p))}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      {p.targets.map((t) => (
                        <PlatformBadge key={t.id} platform={t.platform} muted />
                      ))}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[12px] text-zinc-500 text-right whitespace-nowrap">
                    {['published', 'partial'].includes(p.status)
                      ? fmtCount(postMetric(p, 'views'))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function SocialStudioPage() {
  const { show, node: toastNode } = useToast();
  const [posts, setPosts] = useState<PostRow[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const [composer, setComposer] = useState<{ editing: PostRow | null; date: string | null } | null>(
    null
  );
  const [detail, setDetail] = useState<PostRow | null>(null);
  const [ticking, setTicking] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('dh-social-view');
      if (stored === 'list' || stored === 'calendar') setView(stored);
    } catch {}
  }, []);

  const switchView = (v: 'calendar' | 'list') => {
    setView(v);
    try {
      localStorage.setItem('dh-social-view', v);
    } catch {}
  };

  const load = useCallback(async () => {
    // Settled, not all-or-nothing: a failing accounts call used to take the
    // whole calendar down with it, which read as "the studio is empty".
    const [postsRes, accountsRes] = await Promise.allSettled([
      api<{ posts: PostRow[] }>('/api/social/posts?limit=200'),
      api<{ accounts: AccountRow[] }>('/api/social/accounts'),
    ]);

    if (postsRes.status === 'fulfilled') {
      setPosts(postsRes.value.posts);
    } else {
      const e = postsRes.reason;
      show(e instanceof Error ? e.message : 'Failed to load — has migration 019 been applied?', 'err');
      setPosts([]);
    }

    if (accountsRes.status === 'fulfilled') {
      setAccounts(accountsRes.value.accounts);
    } else {
      const e = accountsRes.reason;
      show(
        e instanceof Error ? `Couldn't load accounts: ${e.message}` : "Couldn't load accounts",
        'err'
      );
    }
  }, [show]);

  useEffect(() => {
    load();
  }, [load]);

  /**
   * Fire-and-forget publish. The engine call runs inline server-side (it can
   * take ~30s while Instagram transcodes), so the UI shows the post's
   * Publishing state right away and toasts the outcome when the call lands.
   */
  const publishPost = useCallback(
    (id: string) => {
      show('Publishing…');
      api<{ summary: { targetsPublished: number; targetsProcessing: number; targetsFailed: number } }>(
        `/api/social/posts/${id}/publish`,
        { method: 'POST', body: '{}' }
      )
        .then(({ summary }) => {
          if (summary.targetsFailed > 0) {
            show('Some platforms failed — open the post for details', 'err');
          } else if (summary.targetsProcessing > 0) {
            show('Still processing — it finishes automatically');
          } else {
            show('Published ✓');
          }
        })
        .catch((e) => show(e instanceof Error ? e.message : 'Publish failed', 'err'))
        .finally(load);
      // Reflect the Publishing state on the card immediately.
      setTimeout(load, 600);
    },
    [load, show]
  );

  // While anything is mid-publish, keep the board fresh so Publishing flips
  // to Published without a manual reload (covers cron-finished posts too).
  useEffect(() => {
    if (!posts?.some((p) => p.status === 'publishing')) return;
    const t = setTimeout(load, 8000);
    return () => clearTimeout(t);
  }, [posts, load]);

  const runEngine = async () => {
    setTicking(true);
    try {
      const res = await api<{ targetsPublished: number; targetsProcessing: number }>(
        '/api/social/tick',
        { method: 'POST', body: '{}' }
      );
      show(`Engine ran — ${res.targetsPublished} published, ${res.targetsProcessing} processing`);
      load();
    } catch (e) {
      show(e instanceof Error ? e.message : 'Tick failed', 'err');
    } finally {
      setTicking(false);
    }
  };

  const byDay = useMemo(() => {
    const map = new Map<string, PostRow[]>();
    for (const p of posts || []) {
      const iso = p.scheduled_at || p.published_at;
      if (!iso) continue;
      const key = dayKey(new Date(iso));
      map.set(key, [...(map.get(key) || []), p]);
    }
    for (const list of map.values()) {
      list.sort((a, b) =>
        (a.scheduled_at || a.published_at || '').localeCompare(b.scheduled_at || b.published_at || '')
      );
    }
    return map;
  }, [posts]);

  const drafts = (posts || []).filter((p) => p.status === 'draft');
  const upNext = (posts || [])
    .filter((p) => ['scheduled', 'publishing'].includes(p.status))
    .sort((a, b) => (a.scheduled_at || '').localeCompare(b.scheduled_at || ''))
    .slice(0, 8);

  if (posts === null) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title="Social" />
        <SocialNav />
        <Loading />
      </div>
    );
  }

  const grid = monthGrid(cursor);
  const todayKey = dayKey(new Date());
  const monthLabel = cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

  const viewToggle = (
    <div className="flex rounded-lg border border-minimal-border overflow-hidden">
      <button
        type="button"
        onClick={() => switchView('list')}
        title="List view"
        className={`px-2.5 py-1.5 transition-colors ${
          view === 'list' ? 'bg-minimal-row text-white' : 'text-minimal-muted hover:text-white'
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 256 256" fill="currentColor">
          <path d="M224,64a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16H216A8,8,0,0,1,224,64Zm-8,56H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16ZM48,56a12,12,0,1,0,12,12A12,12,0,0,0,48,56Zm0,60a12,12,0,1,0,12,12A12,12,0,0,0,48,116Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,48,180Z" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => switchView('calendar')}
        title="Calendar view"
        className={`px-2.5 py-1.5 transition-colors ${
          view === 'calendar' ? 'bg-minimal-row text-white' : 'text-minimal-muted hover:text-white'
        }`}
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 256 256" fill="currentColor">
          <path d="M208,32H184V24a8,8,0,0,0-16,0v8H88V24a8,8,0,0,0-16,0v8H48A16,16,0,0,0,32,48V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V48A16,16,0,0,0,208,32ZM72,48v8a8,8,0,0,0,16,0V48h80v8a8,8,0,0,0,16,0V48h24V80H48V48ZM208,208H48V96H208V208Z" />
        </svg>
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {toastNode}
      <PageHeader title="Social">
        {viewToggle}
        <GhostBtn
          onClick={runEngine}
          disabled={ticking}
          title="Run the scheduler now instead of waiting for the cron: publishes any due scheduled posts, checks on Instagram/Facebook processing, and refreshes metrics"
        >
          {ticking ? 'Running…' : 'Run engine'}
        </GhostBtn>
        <PrimaryBtn onClick={() => setComposer({ editing: null, date: null })}>New post</PrimaryBtn>
      </PageHeader>
      <SocialNav />

      <div className="flex-1 overflow-y-auto px-12 py-8">
        {accounts.filter((a) => a.status === 'active').length === 0 && (
          <div className="mb-6 px-4 py-3 border border-yellow-500/30 bg-yellow-500/5 rounded-lg text-[13px] text-yellow-400">
            No platform accounts connected yet — open the Accounts tab to link Instagram, Facebook,
            and YouTube before scheduling.
          </div>
        )}

        {view === 'list' ? (
          <ListView posts={posts} onOpen={setDetail} />
        ) : (
          <>
            {/* calendar header */}
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-semibold text-white">{monthLabel}</h2>
              <div className="flex items-center gap-2">
                <GhostBtn onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
                  ←
                </GhostBtn>
                <GhostBtn onClick={() => setCursor(startOfMonth(new Date()))}>Today</GhostBtn>
                <GhostBtn onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
                  →
                </GhostBtn>
              </div>
            </div>

            {/* calendar */}
            <div className="border border-minimal-border rounded-xl overflow-hidden">
              <div className="grid grid-cols-7 border-b border-minimal-border">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                  <div key={d} className="px-3 py-2 text-[11px] font-semibold text-zinc-500 uppercase tracking-wider">
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7">
                {grid.map((day, i) => {
                  const key = dayKey(day);
                  const inMonth = day.getMonth() === cursor.getMonth();
                  const dayPosts = byDay.get(key) || [];
                  return (
                    <div
                      key={i}
                      onClick={() => setComposer({ editing: null, date: key })}
                      className={`min-h-[132px] p-1.5 border-b border-r border-minimal-border/60 cursor-pointer transition-colors hover:bg-minimal-row/50 ${
                        inMonth ? '' : 'opacity-40'
                      } ${i % 7 === 6 ? 'border-r-0' : ''} ${i >= 35 ? 'border-b-0' : ''}`}
                    >
                      <div
                        className={`text-[11px] font-medium mb-1.5 px-1 ${
                          key === todayKey
                            ? 'text-black bg-white rounded w-5 h-5 flex items-center justify-center'
                            : 'text-zinc-500'
                        }`}
                      >
                        {day.getDate()}
                      </div>
                      <div className="flex flex-col gap-1.5">
                        {dayPosts.slice(0, 2).map((p) => (
                          <button
                            key={p.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setDetail(p);
                            }}
                            className="w-full text-left rounded-lg border border-minimal-border bg-minimal-row overflow-hidden hover:border-zinc-500 transition-colors"
                          >
                            <div className="px-2 pt-1.5 flex items-center justify-between gap-2">
                              <span className="text-[10px] font-medium text-zinc-500">
                                {fmtTime(p.scheduled_at || p.published_at)}
                              </span>
                              <span className="flex items-center gap-1">
                                {p.targets.map((t) => (
                                  <span
                                    key={t.id}
                                    className={`w-1.5 h-1.5 rounded-full ${PLATFORM_META[t.platform].dot}`}
                                    title={PLATFORM_META[t.platform].label}
                                  />
                                ))}
                              </span>
                            </div>
                            <p className="px-2 pt-1 text-[11px] leading-snug text-zinc-300 line-clamp-2">
                              {p.title || p.caption.split('\n')[0] || 'Untitled'}
                            </p>
                            {(p.post_type === 'carousel' ? p.media?.[0] : p.video_url) && (
                              <div className="px-2 pt-1.5 relative">
                                {p.post_type === 'carousel' ? (
                                  // eslint-disable-next-line @next/next/no-img-element
                                  <img
                                    src={p.media[0].url}
                                    alt=""
                                    className="w-full h-16 object-cover rounded"
                                  />
                                ) : (
                                  <video
                                    src={p.video_url!}
                                    className="w-full h-16 object-cover rounded"
                                    muted
                                    playsInline
                                    preload="metadata"
                                  />
                                )}
                                {p.post_type === 'carousel' && p.media.length > 1 && (
                                  <span className="absolute bottom-1 right-3 px-1 text-[9px] font-semibold bg-black/70 text-white rounded">
                                    {p.media.length}
                                  </span>
                                )}
                              </div>
                            )}
                            <div className="px-2 py-1.5">
                              <PostStatusPill status={p.status} />
                            </div>
                          </button>
                        ))}
                        {dayPosts.length > 2 && (
                          <span className="text-[10px] text-zinc-600 px-1.5">
                            +{dayPosts.length - 2} more
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* queue + drafts */}
            <div className="grid grid-cols-2 gap-8 mt-8">
              <section>
                <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Up next</h2>
                {upNext.length === 0 ? (
                  <EmptyState title="Nothing scheduled" hint="Click a day on the calendar or hit New post." />
                ) : (
                  <div className="flex flex-col gap-2">
                    {upNext.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setDetail(p)}
                        className="flex items-center gap-3 px-4 py-3 border border-minimal-border rounded-lg text-left hover:border-zinc-600 transition-colors"
                      >
                        <StatusDot status={p.status} map={POST_STATUS_DOTS} />
                        <span className="text-[13px] text-white flex-1 truncate">
                          {p.title || p.caption.split('\n')[0] || 'Untitled'}
                        </span>
                        <span className="flex items-center gap-2">
                          {p.targets.map((t) => (
                            <PlatformBadge key={t.id} platform={t.platform} muted />
                          ))}
                        </span>
                        <span className="text-[12px] text-zinc-500 w-36 text-right">
                          {fmtDate(p.scheduled_at)}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
              <section>
                <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Drafts</h2>
                {drafts.length === 0 ? (
                  <EmptyState title="No drafts" hint="Save a post without scheduling to park it here." />
                ) : (
                  <div className="flex flex-col gap-2">
                    {drafts.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setDetail(p)}
                        className="flex items-center gap-3 px-4 py-3 border border-minimal-border rounded-lg text-left hover:border-zinc-600 transition-colors"
                      >
                        <span className="text-[13px] text-zinc-300 flex-1 truncate">
                          {p.title || p.caption.split('\n')[0] || 'Untitled'}
                        </span>
                        <span className="text-[12px] text-zinc-600">{fmtDate(p.created_at)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>

            {/* recently published */}
            <section className="mt-8 mb-12">
              <h2 className="text-[13px] font-semibold text-zinc-300 mb-3">Recently published</h2>
              {(posts || []).filter((p) => ['published', 'partial'].includes(p.status)).length === 0 ? (
                <EmptyState title="Nothing published yet" />
              ) : (
                <div className="flex flex-col gap-2">
                  {(posts || [])
                    .filter((p) => ['published', 'partial'].includes(p.status))
                    .slice(0, 10)
                    .map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setDetail(p)}
                        className="flex items-center gap-3 px-4 py-3 border border-minimal-border rounded-lg text-left hover:border-zinc-600 transition-colors"
                      >
                        <StatusDot status={p.status} map={POST_STATUS_DOTS} />
                        <span className="text-[13px] text-white flex-1 truncate">
                          {p.title || p.caption.split('\n')[0] || 'Untitled'}
                        </span>
                        <span className="text-[12px] text-zinc-500">
                          {fmtCount(postMetric(p, 'views'))} views
                        </span>
                        <span className="text-[12px] text-zinc-500 w-36 text-right">
                          {fmtDate(p.published_at)}
                        </span>
                      </button>
                    ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {composer && (
        <Composer
          accounts={accounts}
          editing={composer.editing}
          prefillDate={composer.date}
          onClose={() => setComposer(null)}
          onSaved={load}
          onPublishNow={publishPost}
          show={show}
        />
      )}
      {detail && (
        <PostDetail
          post={detail}
          onClose={() => setDetail(null)}
          onEdit={() => {
            setComposer({ editing: detail, date: null });
            setDetail(null);
          }}
          onChanged={load}
          onPublishNow={publishPost}
          show={show}
        />
      )}
    </div>
  );
}
