import { NextRequest, NextResponse } from "next/server";
import { authenticateCornermanConversion, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { applyCornermanConversion } from "@/lib/integrations/cornerman/apply";
import {
  configuredIntegrationEnv,
  parseConversionPayload,
  receiptContainsPrivateData,
} from "@/lib/integrations/cornerman/contract";

export async function POST(request: NextRequest) {
  const auth = await authenticateCornermanConversion(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const environment = configuredIntegrationEnv();
  if (!environment) {
    return NextResponse.json({ error: "Integration environment is not configured" }, { status: 503 });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseConversionPayload(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }
  if (parsed.payload.environment !== environment) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const result = await applyCornermanConversion(createAdminClient(), parsed.payload, parsed.payloadHash);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  if (receiptContainsPrivateData(result.receipt)) {
    return NextResponse.json({ error: "Conversion could not be applied" }, { status: 500 });
  }
  return NextResponse.json({ receipt: result.receipt, code: result.code });
}
