/**
 * POST /api/social/upload/complete — finish (or abort) a multipart upload.
 * Body: { key, uploadId, expiry, token, parts: [{ part, etag }], abort? }
 * → { publicUrl } (or { aborted: true })
 */
import { NextRequest, NextResponse } from "next/server";
import { publicMediaUrl, socialBucket, verifyUploadToken } from "@/lib/social/upload";

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as {
    key?: string;
    uploadId?: string;
    expiry?: number;
    token?: string;
    parts?: Array<{ part: number; etag: string }>;
    abort?: boolean;
  } | null;
  if (!body?.key || !body.uploadId) {
    return NextResponse.json({ error: "key and uploadId are required" }, { status: 400 });
  }
  if (!verifyUploadToken(body.key, body.uploadId, Number(body.expiry), body.token || "")) {
    return NextResponse.json({ error: "Invalid or expired upload token" }, { status: 401 });
  }

  const upload = socialBucket().resumeMultipartUpload(body.key, body.uploadId);
  try {
    if (body.abort) {
      await upload.abort();
      return NextResponse.json({ aborted: true });
    }
    const parts = (body.parts || []).map((p) => ({ partNumber: p.part, etag: p.etag }));
    if (!parts.length) {
      return NextResponse.json({ error: "parts are required to complete" }, { status: 400 });
    }
    await upload.complete(parts);
    return NextResponse.json({ key: body.key, publicUrl: publicMediaUrl(body.key) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not complete the upload" },
      { status: 500 }
    );
  }
}
