#!/usr/bin/env node
/**
 * connect-meta.mjs — connect the Facebook page (+ its linked Instagram) to the
 * social engine using a token on your clipboard. Never prints the token.
 *
 * Usage:
 *   1. Copy a Meta token to the clipboard (system-user token OR a page token)
 *   2. node scripts/connect-meta.mjs
 *
 * Accepts either token type: a system-user token is exchanged for the page
 * token via /me/accounts; a page token is used directly.
 *
 * Auth: HMAC machine auth using API_SECRET_KEY from .env.local
 */
import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set BASE to your deployed backend origin, e.g. BASE=https://backend.yourdomain.com
const BASE = process.env.BASE || 'http://localhost:3001';
const GRAPH = 'https://graph.facebook.com/v23.0';

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

const clip = execSync('pbpaste').toString().split('\n')[0].trim();
if (!clip || clip.length < 50) {
  console.error(`Clipboard does not look like a token (${clip.length} chars). Copy the token and re-run.`);
  process.exit(1);
}
console.log(`Token found on clipboard (${clip.length} chars).`);

async function graph(path, token) {
  const url = new URL(`${GRAPH}${path}`);
  url.searchParams.set('access_token', token);
  url.searchParams.set(
    'fields',
    'id,name,access_token,instagram_business_account{id,username}'
  );
  const res = await fetch(url);
  return res.json();
}

// A system-user token resolves pages via /me/accounts; a page token does not.
let pageToken = null;
let pageName = null;
let igLinked = false;

const accounts = await graph('/me/accounts', clip);
if (accounts?.data?.length) {
  const page = accounts.data[0];
  pageToken = page.access_token;
  pageName = page.name;
  igLinked = Boolean(page.instagram_business_account);
  console.log(`Resolved page "${pageName}" from system-user token.`);
} else {
  // Maybe the clipboard already holds a page token — /me would then be the Page.
  const me = await graph('/me', clip);
  if (me?.id && !me.error) {
    pageToken = clip;
    pageName = me.name;
    igLinked = Boolean(me.instagram_business_account);
    console.log(`Clipboard is already a page token for "${pageName}".`);
  } else {
    console.error('Could not resolve a page from this token.');
    console.error('  /me/accounts:', accounts?.error?.message || 'no data');
    console.error('  /me         :', me?.error?.message || 'no id');
    process.exit(1);
  }
}

console.log(`Instagram linked and visible to this token: ${igLinked ? 'YES' : 'NO'}`);

const path = '/api/social/accounts';
const body = JSON.stringify({ platform: 'meta', page_token: pageToken });
const ts = String(Math.floor(Date.now() / 1000));
const signature = createHmac('sha256', SECRET).update(`POST:${path}:${ts}:${body}`).digest('hex');

const res = await fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': SECRET,
    'x-timestamp': ts,
    'x-signature': signature,
  },
  body,
});
const json = await res.json().catch(() => ({}));
console.log(`\nConnect → HTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2));

if (res.status !== 200 && res.status !== 201) process.exit(1);
console.log('\nConnected. Check /social/accounts.');
