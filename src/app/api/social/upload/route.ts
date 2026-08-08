/**
 * POST /api/social/upload — start a multipart upload to the social-media R2
 * bucket. Returns the key, uploadId, part size, the final public URL, and a
 * scoped token for the part/complete calls.
 * Body: { filename, contentType } →
 *   { key, uploadId, partSize, publicUrl, token, expiry }
 *
 * Media used to live in Supabase Storage (50MB project cap, billed egress);
 * R2 has no practical size cap for us and free egress for Meta's pulls.
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { authenticateSessionOrApiKey, unauthorizedResponse } from "@/lib/api/auth";
import {
  ALLOWED_UPLOAD_TYPES,
  mintUploadToken,
  PART_SIZE,
  publicMediaUrl,
  socialBucket,
} from "@/lib/social/upload";

export async function POST(request: NextRequest) {
  const auth = await authenticateSessionOrApiKey(request, { allowRoles: ["admin", "social"] });
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const body = (await request.json().catch(() => null)) as {
    filename?: string;
    contentType?: string;
  } | null;
  if (!body?.filename) {
    return NextResponse.json({ error: "filename is required" }, { status: 400 });
  }
  if (body.contentType && !ALLOWED_UPLOAD_TYPES.includes(body.contentType)) {
    return NextResponse.json(
      { error: "Upload an MP4, MOV, or WebM video — or a JPEG, PNG, or WebP image" },
      { status: 400 }
    );
  }

  const safeName = body.filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-80);
  const key = `${randomUUID()}/${safeName}`;

  try {
    const upload = await socialBucket().createMultipartUpload(key, {
      httpMetadata: { contentType: body.contentType || "application/octet-stream" },
    });
    const { token, expiry } = mintUploadToken(key, upload.uploadId);
    return NextResponse.json({
      key,
      // kept for callers that still read `path`
      path: key,
      uploadId: upload.uploadId,
      partSize: PART_SIZE,
      publicUrl: publicMediaUrl(key),
      token,
      expiry,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not start the upload" },
      { status: 500 }
    );
  }
}
