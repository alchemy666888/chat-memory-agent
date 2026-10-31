import type { Pool } from "pg";
import { authenticateBearer } from "@/server/auth/tokens";
import {
  parseProcessBody,
  REQUEST_BODY_MAX_BYTES,
} from "@/server/chat-memory/contracts";
import {
  processNextChat,
  type ProcessDependencies,
} from "@/server/chat-memory/process";
import { readProcessConfig } from "@/server/config";
import { requestSummary, type ModelExchange } from "@/server/deepseek/client";
import { readJsonBody } from "@/server/http/body";
import { logFailureClass, publicFailureCode } from "@/server/http/logging";
import {
  errorResponse,
  jsonResponse,
  requestIdFrom,
} from "@/server/http/response";
import { getPool } from "@/server/postgres/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request): Promise<Response> {
  return postProcess(request);
}

export async function postProcess(
  request: Request,
  dependencies?: Partial<
    Pick<
      ProcessDependencies,
      "pool" | "complete" | "chunkLimit" | "hooks" | "now"
    >
  > & { pool?: Pool },
): Promise<Response> {
  const requestId = requestIdFrom(request);
  try {
    const config = readProcessConfig();
    const others = [
      config.CHAT_MEMORY_INGEST_TOKEN,
      config.CHAT_MEMORY_READ_TOKEN,
    ].filter((token): token is string => token !== undefined);
    authenticateBearer(
      request.headers.get("authorization"),
      config.CHAT_MEMORY_PROCESS_TOKEN,
      others,
    );
    parseProcessBody(await readJsonBody(request, REQUEST_BODY_MAX_BYTES));
    const pool = dependencies?.pool ?? getPool(config);
    const complete =
      dependencies?.complete ??
      ((exchange: ModelExchange) =>
        requestSummary({
          apiKey: config.DEEPSEEK_API_KEY,
          baseUrl: config.DEEPSEEK_BASE_URL,
          model: config.DEEPSEEK_SUMMARY_MODEL,
          exchange,
        }));
    const result = await processNextChat({
      pool,
      requestId,
      modelName: config.DEEPSEEK_SUMMARY_MODEL,
      complete,
      maxMessages: config.MEMORY_BATCH_MAX_MESSAGES,
      maxCharacters: config.MEMORY_BATCH_MAX_CHARACTERS,
      deadlineMs: config.MEMORY_PROCESS_TIMEOUT_MS,
      ...(dependencies?.chunkLimit === undefined
        ? {}
        : { chunkLimit: dependencies.chunkLimit }),
      ...(dependencies?.hooks ? { hooks: dependencies.hooks } : {}),
      ...(dependencies?.now ? { now: dependencies.now } : {}),
    });
    return jsonResponse(200, result, requestId);
  } catch (error) {
    logFailureClass(requestId, publicFailureCode(error));
    return errorResponse(error, requestId);
  }
}
