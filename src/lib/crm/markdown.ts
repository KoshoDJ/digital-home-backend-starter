import { marked } from "marked";
import type { CrmSender } from "./types";

marked.setOptions({ gfm: true, breaks: true });

/**
 * Renders email markdown to a minimal, deliverability-friendly HTML email.
 * Single column, max 600px, mostly text — intentionally close to a personal
 * email rather than a "designed" newsletter (better inbox placement + replies).
 *
 * A paragraph containing ONLY a link is upgraded to a button-style CTA.
 */
export function renderEmailHtml(opts: {
  bodyMd: string;
  preheader?: string | null;
  sender: CrmSender;
  unsubscribeUrl: string;
}): string {
  let body = marked.parse(opts.bodyMd) as string;

  // Upgrade paragraphs that contain only a single link into CTA buttons
  body = body.replace(
    /<p>\s*(<a href="[^"]+"[^>]*>[^<]+<\/a>)\s*<\/p>/g,
    (_m, anchor: string) =>
      `<p style="margin:28px 0;">${anchor.replace(
        "<a ",
        '<a style="display:inline-block;background:#0968ff;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;" '
      )}</p>`
  );

  const preheaderHtml = opts.preheader
    ? `<span style="display:none;font-size:1px;color:#ffffff;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(
        opts.preheader
      )}</span>`
    : "";

  const addressHtml = opts.sender.address
    ? `<div style="margin-top:6px;">${escapeHtml(opts.sender.address)}</div>`
    : "";

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#ffffff;">
${preheaderHtml}
<div style="max-width:600px;margin:0 auto;padding:32px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.7;color:#1a1a1a;">
<style>
  a { color: #0968ff; }
  h1 { font-size: 24px; line-height: 1.3; margin: 0 0 16px; }
  h2 { font-size: 20px; line-height: 1.35; margin: 28px 0 12px; }
  h3 { font-size: 17px; margin: 24px 0 8px; }
  p { margin: 0 0 16px; }
  ul, ol { margin: 0 0 16px 22px; padding: 0; }
  li { margin-bottom: 6px; }
  blockquote { border-left: 3px solid #e5e5e5; margin: 16px 0; padding: 4px 0 4px 16px; color: #555; }
  hr { border: none; border-top: 1px solid #eaeaea; margin: 28px 0; }
  img { max-width: 100%; height: auto; border-radius: 10px; margin: 8px 0; }
</style>
${body}
<div style="margin-top:40px;padding-top:20px;border-top:1px solid #eaeaea;font-size:12px;line-height:1.6;color:#999999;">
<div>${escapeHtml(opts.sender.from_name)}</div>
${addressHtml}
<div style="margin-top:6px;">You're receiving this because you subscribed on our website. <a href="${opts.unsubscribeUrl}" style="color:#999999;text-decoration:underline;">Unsubscribe</a></div>
</div>
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
