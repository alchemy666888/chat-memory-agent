import type { Pool } from "pg";
import { authenticateBearer } from "@/server/auth/tokens";
import {
  parseIngestBody,
  REQUEST_BODY_MAX_BYTES,
} from "@/server/chat-memory/contracts";
import { ingestMessage } from "@/server/chat-memory/ingestion";
import { readIngestConfig } from "@/server/config";
import { readJsonBody } from "@/server/http/body";
import {
  logDiagnostic,
  logFailureClass,
  publicFailureCode,
} from "@/server/http/logging";
import {
  errorResponse,
  jsonResponse,
  requestIdFrom,
} from "@/server/http/response";
import { getPool } from "@/server/postgres/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  return postMessages(request);
}

export async function postMessages(
  request: Request,
  dependencies?: { pool?: Pool },
): Promise<Response> {
  const requestId = requestIdFrom(request);
  const started = Date.now();
  try {
    const config = readIngestConfig();
    const others = [
      config.CHAT_MEMORY_PROCESS_TOKEN,
      config.CHAT_MEMORY_READ_TOKEN,
    ].filter((token): token is string => token !== undefined);
    authenticateBearer(
      request.headers.get("authorization"),
      config.CHAT_MEMORY_INGEST_TOKEN,
      others,
    );
    const body = parseIngestBody(
      await readJsonBody(request, REQUEST_BODY_MAX_BYTES),
    );
    const pool = dependencies?.pool ?? getPool(config);
    const stored = await ingestMessage(pool, body);
    logDiagnostic({
      request_id: requestId,
      phase: "ingest",
      duration_ms: Date.now() - started,
      result: stored.result,
      telegram_chat_id: body.telegramChatId,
      captured_rows: stored.result === "stored" ? 1 : 0,
    });
    return jsonResponse(
      stored.result === "stored" ? 201 : 200,
      {
        contract_version: 1,
        result: stored.result,
        raw_message_id: stored.rawMessageId,
      },
      requestId,
    );
  } catch (error) {
    logFailureClass(requestId, publicFailureCode(error));
    return errorResponse(error, requestId);
  }
}
