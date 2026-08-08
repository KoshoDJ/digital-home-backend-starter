/**
 * PUT /api/social/upload/part?key=&uploadId=&part=N&expiry=&token=
 * Body: raw bytes for this part (≤ PART_SIZE). → { etag }
 * Auth: the scoped upload token from POST /api/social/upload — the create
 * route did the real authentication; signing 40MB binary bodies with the
 * HMAC scheme would be slow and lossy.
 */
import { NextRequest, NextResponse } from "next/server";
import { socialBucket, verifyUploadToken } from "@/lib/social/upload";

export const maxDuration = 120;

export async function PUT(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const key = q.get("key") || "";
  const uploadId = q.get("uploadId") || "";
  const part = parseInt(q.get("part") || "0", 10);
  const expiry = Number(q.get("expiry") || "0");
  const token = q.get("token") || "";

  if (!key || !uploadId || !part || part < 1) {
    return NextResponse.json({ error: "key, uploadId, and part are required" }, { status: 400 });
  }
  if (!verifyUploadToken(key, uploadId, expiry, token)) {
    return NextResponse.json({ error: "Invalid or expired upload token" }, { status: 401 });
  }

  try {
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) {
      return NextResponse.json({ error: "Empty part body" }, { status: 400 });
    }
    const upload = socialBucket().resumeMultipartUpload(key, uploadId);
    const uploaded = await upload.uploadPart(part, bytes);
    return NextResponse.json({ etag: uploaded.etag, part: uploaded.partNumber });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Part upload failed" },
      { status: 500 }
    );
  }
}
