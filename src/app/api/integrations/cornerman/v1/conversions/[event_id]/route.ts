import { NextRequest, NextResponse } from "next/server";
import { authenticateCornermanConversion, unauthorizedResponse } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/server";
import { readCornermanConversion } from "@/lib/integrations/cornerman/apply";
import { configuredIntegrationEnv, receiptContainsPrivateData } from "@/lib/integrations/cornerman/contract";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ event_id: string }> }
) {
  const auth = await authenticateCornermanConversion(request);
  if (!auth.authenticated) return unauthorizedResponse(auth.error);

  const environment = configuredIntegrationEnv();
  if (!environment) {
    return NextResponse.json({ error: "Integration environment is not configured" }, { status: 503 });
  }

  const { event_id: eventId } = await params;
  if (!UUID_RE.test(eventId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await readCornermanConversion(createAdminClient(), eventId, environment);
  if (result.status === "error") {
    return NextResponse.json({ error: "Conversion could not be read" }, { status: 500 });
  }
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (receiptContainsPrivateData(result.receipt)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ receipt: result.receipt });
}
