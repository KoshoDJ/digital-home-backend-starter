#!/usr/bin/env node
/**
 * social-post.mjs — schedule and publish social posts from the command line,
 * so Claude (or any agent with the master key) can run the calendar without
 * the dashboard. Videos and multi-slide carousels both work.
 *
 * Usage:
 *   node scripts/social-post.mjs accounts
 *   node scripts/social-post.mjs list [--status scheduled] [--limit 20]
 *   node scripts/social-post.mjs create --caption "..." [options]
 *   node scripts/social-post.mjs publish <post-id>
 *   node scripts/social-post.mjs tick [--post-id <post-id>]
 *
 * create options:
 *   --caption "text"           caption (or --caption-file path)
 *   --title "text"             internal label / YouTube title
 *   --type video|carousel      default: inferred (a video file → video,
 *                              images only → photo/carousel post)
 *   --media a.mp4 b.jpg …      local files, uploaded to the social bucket;
 *                              carousel slide order = argument order
 *   --when "2026-08-05T11:00"  local time (or ISO with zone); omit = draft
 *   --platforms ig,fb,yt       default: every active account the type allows
 *   --draft                    save as draft even if --when is set
 *   --publish-now              schedule for now and run the engine inline
 *
 * Auth: HMAC machine auth using API_SECRET_KEY from .env.local.
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set BASE to your deployed backend origin, e.g. BASE=https://backend.yourdomain.com
const BASE = process.env.BASE || 'http://localhost:3001';
// Cloudflare fronts the backend and 403s obvious non-browser agents (error 1010).
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local');
const env = {};
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const SECRET = env.API_SECRET_KEY;
if (!SECRET) {
  console.error('API_SECRET_KEY missing from .env.local');
  process.exit(1);
}

async function api(method, path, body) {
  const bodyText = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  // The server signs pathname only — strip any query string before signing.
  const pathname = path.split('?')[0];
  const signature = createHmac('sha256', SECRET)
    .update(`${method}:${pathname}:${ts}:${bodyText}`)
    .digest('hex');
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': UA,
      'x-api-key': SECRET,
      'x-timestamp': ts,
      'x-signature': signature,
    },
    body: bodyText || undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → HTTP ${res.status}: ${json.error || JSON.stringify(json)}`);
  }
  return json;
}

const MIME = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Instagram feed accepts 4:5 (0.8) through 1.91:1. */
const IG_MIN_RATIO = 0.8;
const IG_MAX_RATIO = 1.91;
const TARGET_NORMALIZED_VIDEO_BYTES = 58 * 1024 * 1024;
const MAX_NORMALIZED_VIDEO_BYTES = 60 * 1024 * 1024;
const MAX_VIDEO_BITRATE = 8_000_000;

function mediaTool(name) {
  const bundled = join(homedir(), 'bin', name);
  return existsSync(bundled) ? bundled : name;
}

/**
 * Mirror of the composer's upload-time normalization, via macOS sips:
 * center-crop out-of-range images to the nearest Instagram-legal ratio,
 * cap width at 1440, and re-encode as JPEG. Returns a temp file path.
 */
function normalizeImage(filePath) {
  const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath])
    .toString()
    .match(/pixelWidth: (\d+)[\s\S]*pixelHeight: (\d+)/);
  if (!dims) throw new Error(`Could not read image dimensions: ${filePath}`);
  const width = Number(dims[1]);
  const height = Number(dims[2]);
  const ratio = width / height;
  const target = ratio < IG_MIN_RATIO ? IG_MIN_RATIO : ratio > IG_MAX_RATIO ? IG_MAX_RATIO : ratio;
  let cropW = width;
  let cropH = height;
  if (ratio < target) cropH = Math.round(width / target);
  else if (ratio > target) cropW = Math.round(height * target);

  const out = join(tmpdir(), `social-post-${randomUUID()}.jpg`);
  const ops = ['-s', 'format', 'jpeg', '-s', 'formatOptions', '90'];
  if (cropW !== width || cropH !== height) ops.push('-c', String(cropH), String(cropW));
  if (cropW > 1440) ops.push('--resampleWidth', '1440');
  execFileSync('sips', [...ops, filePath, '--out', out], { stdio: 'pipe' });
  if (target !== ratio) {
    console.log(`  auto-cropped ${basename(filePath)} ${width}x${height} → ${cropW}x${cropH} (IG range)`);
  }
  return out;
}

/**
 * Normalize every video, even when it is already 9:16. Raw screen captures can
 * be 100–200 MB despite having the right dimensions; the bounded H.264 encode
 * keeps a typical one-minute Reel around 55–60 MB and pads off-ratio inputs
 * without cropping.
 * Fail closed if ffmpeg is unavailable so an unsafe raw file cannot be queued.
 */
function normalizeVideo(filePath) {
  try {
    const probe = JSON.parse(execFileSync(mediaTool('ffprobe'), [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:format=duration', '-of', 'json', filePath,
    ]).toString());
    const w = Number(probe.streams?.[0]?.width);
    const h = Number(probe.streams?.[0]?.height);
    const duration = Number(probe.format?.duration);
    if (!w || !h || !Number.isFinite(duration) || duration <= 0) {
      throw new Error('ffprobe could not read video dimensions and duration');
    }
    // Leave room for 128 kbps audio and container overhead. Longer Shorts get
    // a lower ceiling so the normalized output remains safe for every API hop.
    const sizeBoundBitrate = Math.floor((TARGET_NORMALIZED_VIDEO_BYTES * 8) / duration - 192_000);
    const videoBitrate = Math.max(1_200_000, Math.min(MAX_VIDEO_BITRATE, sizeBoundBitrate));
    const out = join(tmpdir(), `social-post-${randomUUID()}.mp4`);
    execFileSync(mediaTool('ffmpeg'), [
      '-y', '-i', filePath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
      '-map', '0:v:0', '-map', '0:a?', '-r', '30',
      '-c:v', 'libx264', '-preset', 'veryfast',
      '-b:v', `${Math.floor(videoBitrate / 1000)}k`,
      '-maxrate', `${Math.floor(videoBitrate / 1000)}k`,
      '-bufsize', `${Math.floor((videoBitrate * 2) / 1000)}k`,
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart',
      out,
    ], { stdio: 'pipe' });
    const outputBytes = statSync(out).size;
    const outputMb = outputBytes / 1024 / 1024;
    if (outputBytes > MAX_NORMALIZED_VIDEO_BYTES) {
      throw new Error(`normalized video is still ${outputMb.toFixed(1)} MB (60 MB safety limit)`);
    }
    console.log(
      `  normalized ${basename(filePath)} ${w}x${h} → 1080x1920 H.264 ` +
      `(${outputMb.toFixed(1)} MB, ≤${(videoBitrate / 1_000_000).toFixed(1)} Mbps)`
    );
    return { path: out, converted: true };
  } catch (e) {
    throw new Error(
      `Video normalization failed for ${basename(filePath)}: ${String(e.message).split('\n')[0]}. ` +
      `Install ffmpeg or export a 1080x1920 H.264 file under 60 MB.`
    );
  }
}

async function uploadFile(filePath) {
  let contentType = MIME[extname(filePath).toLowerCase()];
  if (!contentType) throw new Error(`Unsupported file type: ${filePath}`);
  if (contentType.startsWith('image/')) {
    try {
      filePath = normalizeImage(filePath);
      contentType = 'image/jpeg';
    } catch (e) {
      console.log(`  (image not normalized — uploading as-is: ${e.message})`);
    }
  } else if (contentType.startsWith('video/')) {
    const normalized = normalizeVideo(filePath);
    filePath = normalized.path;
    if (normalized.converted) contentType = 'video/mp4';
  }
  const size = statSync(filePath).size;
  const init = await api('POST', '/api/social/upload', {
    filename: basename(filePath),
    contentType,
  });

  // Multipart to R2 through the API — no size cap, ~40MB parts.
  const bytes = readFileSync(filePath);
  const parts = [];
  for (let part = 1, offset = 0; offset < size || part === 1; part++, offset += init.partSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + init.partSize, size));
    const params = new URLSearchParams({
      key: init.key,
      uploadId: init.uploadId,
      part: String(part),
      expiry: String(init.expiry),
      token: init.token,
    });
    const res = await fetch(`${BASE}/api/social/upload/part?${params}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream', 'User-Agent': UA },
      body: chunk,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Part ${part} of ${basename(filePath)} failed: ${json.error || res.status}`);
    parts.push({ part, etag: json.etag });
    if (offset + init.partSize >= size) break;
  }
  const done = await api('POST', '/api/social/upload/complete', {
    key: init.key,
    uploadId: init.uploadId,
    expiry: init.expiry,
    token: init.token,
    parts,
  });
  console.log(`  uploaded ${basename(filePath)} (${(size / 1024 / 1024).toFixed(1)} MB, ${parts.length} part${parts.length === 1 ? '' : 's'})`);
  return { path: init.key, publicUrl: done.publicUrl, kind: contentType.startsWith('video/') ? 'video' : 'image' };
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      args._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (['draft', 'publish-now'].includes(key)) {
      args[key] = true;
    } else if (key === 'media') {
      args.media = [];
      while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.media.push(argv[++i]);
    } else {
      args[key] = argv[++i];
    }
  }
  return args;
}

const PLATFORM_ALIASES = {
  ig: 'instagram', instagram: 'instagram',
  fb: 'facebook', facebook: 'facebook',
  yt: 'youtube', youtube: 'youtube',
};

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (cmd === 'accounts') {
  const { accounts } = await api('GET', '/api/social/accounts');
  for (const a of accounts) {
    console.log(`${a.id}  ${a.platform.padEnd(9)}  ${a.status.padEnd(12)}  ${a.username ? '@' + a.username : a.name}`);
  }
} else if (cmd === 'list') {
  const params = new URLSearchParams({ limit: args.limit || '20' });
  if (args.status) params.set('status', args.status);
  const { posts } = await api('GET', `/api/social/posts?${params}`);
  for (const p of posts) {
    const when = p.scheduled_at || p.published_at || p.created_at;
    const platforms = p.targets.map((t) => `${t.platform}:${t.status}`).join(' ') || 'no targets';
    console.log(`${p.id}  [${p.status}] [${p.post_type}] ${when}  ${platforms}`);
    console.log(`  ${(p.title || p.caption.split('\n')[0] || 'Untitled').slice(0, 90)}`);
  }
} else if (cmd === 'create') {
  const caption = args['caption-file']
    ? readFileSync(args['caption-file'], 'utf8').trim()
    : args.caption || '';
  if (!caption) {
    console.error('A caption is required (--caption or --caption-file)');
    process.exit(1);
  }

  const files = args.media || [];
  console.log(files.length ? `Uploading ${files.length} file(s)…` : 'No media given.');
  const uploaded = [];
  for (const f of files) uploaded.push(await uploadFile(f));

  const images = uploaded.filter((u) => u.kind === 'image');
  const videos = uploaded.filter((u) => u.kind === 'video');
  // A video file → video post; images only → photo (1) / carousel (2–10).
  const type = args.type || (images.length >= 1 && videos.length === 0 ? 'carousel' : 'video');

  if (type === 'video' && videos.length !== 1 && !args.draft) {
    console.error('A video post needs exactly one video file (--media clip.mp4), or pass --draft.');
    process.exit(1);
  }
  if (type === 'carousel' && (images.length < 1 || images.length > 10) && !args.draft) {
    console.error('An image post needs 1–10 image files, or pass --draft.');
    process.exit(1);
  }

  const { accounts } = await api('GET', '/api/social/accounts');
  const allowed = type === 'carousel' ? ['instagram', 'facebook'] : ['instagram', 'facebook', 'youtube'];
  const wanted = args.platforms
    ? args.platforms.split(',').map((p) => PLATFORM_ALIASES[p.trim().toLowerCase()]).filter(Boolean)
    : allowed;
  const accountIds = accounts
    .filter((a) => a.status === 'active' && allowed.includes(a.platform) && wanted.includes(a.platform))
    .map((a) => a.id);

  const scheduling = !args.draft && (args.when || args['publish-now']);
  const scheduledAt = args['publish-now']
    ? new Date().toISOString()
    : args.when
      ? new Date(args.when).toISOString()
      : null;

  const payload = {
    title: args.title,
    caption,
    post_type: type,
    video_path: type === 'video' ? videos[0]?.path : undefined,
    video_url: type === 'video' ? videos[0]?.publicUrl : undefined,
    media:
      type === 'carousel'
        ? images.map((u) => ({ url: u.publicUrl, path: u.path, kind: 'image' }))
        : undefined,
    scheduled_at: scheduledAt,
    account_ids: accountIds,
    status: scheduling ? 'scheduled' : 'draft',
  };
  const { post } = await api('POST', '/api/social/posts', payload);
  console.log(`\nCreated ${post.post_type} post ${post.id} [${post.status}]`);
  if (scheduledAt) console.log(`Scheduled for ${scheduledAt} → ${accountIds.length} account(s)`);

  if (args['publish-now']) {
    console.log('Publishing now…');
    const result = await api('POST', `/api/social/posts/${post.id}/publish`, {});
    console.log(JSON.stringify(result, null, 2));
  }
} else if (cmd === 'publish') {
  const id = args._[0];
  if (!id) {
    console.error('Usage: social-post.mjs publish <post-id>');
    process.exit(1);
  }
  const result = await api('POST', `/api/social/posts/${id}/publish`, {});
  console.log(JSON.stringify(result, null, 2));
} else if (cmd === 'tick') {
  const result = await api('POST', '/api/social/tick', {
    postId: args['post-id'] || undefined,
  });
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error('Commands: accounts | list | create | publish <id> | tick');
  process.exit(1);
}
