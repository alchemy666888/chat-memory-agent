import { readHealthConfig } from "@/server/config";
import { ServiceError } from "@/server/http/errors";
import { logFailureClass } from "@/server/http/logging";
import { jsonResponse, requestIdFrom } from "@/server/http/response";
import { getPool } from "@/server/postgres/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const config = readHealthConfig();
    const pool = getPool(config);
    await pool.query("SELECT 1");
    return jsonResponse(200, { status: "ok" }, requestId);
  } catch (error) {
    const code =
      error instanceof ServiceError ? error.errorCode : "DATABASE_UNAVAILABLE";
    logFailureClass(requestId, code);
    return jsonResponse(503, { status: "unavailable" }, requestId);
  }
}
