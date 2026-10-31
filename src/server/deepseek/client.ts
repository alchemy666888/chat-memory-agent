import "server-only";
import { MAX_OUTPUT_TOKENS } from "../chat-memory/contracts";
import { ServiceError } from "../http/errors";

/**
 * Pinned DeepSeek Responses assumptions, checked against the official
 * /responses documentation:
 * - POST {baseUrl}/responses with a non-streaming JSON response object.
 * - reasoning.effort "none" disables thinking. max_output_tokens covers
 *   visible output and any reasoning tokens.
 * - tools are omitted and tool_choice is "none", so native web search cannot run.
 * - A usable summary requires top-level status "completed", no incomplete_details,
 *   and message text. status "incomplete" is truncation even when text is short.
 * - The API is stateless. Each exchange sends the trusted instructions and the
 *   full untrusted data envelope.
 */
export type ModelCompletion = {
  text: string;
  completed: boolean;
  model: string;
  providerRequestId?: string;
  incompleteReason?: string;
};

export type ModelExchange = {
  instructions: string;
  data: string;
  timeoutMs: number;
};

type ResponseContentPart = { type?: unknown; text?: unknown };
type ResponseItem = {
  type?: unknown;
  status?: unknown;
  content?: unknown;
};

type ResponsesBody = {
  id?: unknown;
  status?: unknown;
  incomplete_details?: { reason?: unknown } | null;
  output_text?: unknown;
  output?: ResponseItem[];
};

export class ProviderCallError extends Error {
  constructor(
    readonly reason: "timeout" | "transport" | "http" | "malformed",
    readonly httpStatus?: number,
  ) {
    super(reason === "http" ? "SUMMARIZATION_FAILED" : reason.toUpperCase());
  }
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export async function requestSummary(options: {
  apiKey: string;
  baseUrl: string;
  model: string;
  exchange: ModelExchange;
  fetchImpl?: typeof fetch;
}): Promise<ModelCompletion> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.exchange.timeoutMs,
  );
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${options.baseUrl}/responses`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          reasoning: { effort: "none" },
          tool_choice: "none",
          max_output_tokens: MAX_OUTPUT_TOKENS,
          instructions: options.exchange.instructions,
          input: [{ role: "user", content: options.exchange.data }],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbort(error)) throw new ProviderCallError("timeout");
      throw new ProviderCallError("transport");
    }
    const providerRequestId = safeId(response.headers.get("x-request-id"));
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderCallError("http", response.status);
    }
    const raw = await readBounded(response, 2_000_000);
    let body: ResponsesBody;
    try {
      body = JSON.parse(raw) as ResponsesBody;
    } catch {
      throw new ProviderCallError("malformed");
    }
    return parseCompletion(
      body,
      options.model,
      providerRequestId ?? safeId(body.id),
    );
  } finally {
    clearTimeout(timer);
  }
}

function parseCompletion(
  body: ResponsesBody,
  model: string,
  providerRequestId?: string,
): ModelCompletion {
  const incompleteReason =
    body.incomplete_details &&
    typeof body.incomplete_details.reason === "string"
      ? body.incomplete_details.reason
      : undefined;
  const toolCall = (body.output ?? []).some((item) =>
    ["function_call", "web_search_call", "custom_tool_call"].includes(
      String(item.type),
    ),
  );
  const messageIncomplete = (body.output ?? []).some(
    (item) =>
      item.type === "message" && item.status && item.status !== "completed",
  );
  const completed =
    body.status === "completed" &&
    body.incomplete_details == null &&
    !toolCall &&
    !messageIncomplete;
  return {
    text: messageText(body),
    completed,
    model,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(incompleteReason ? { incompleteReason } : {}),
  };
}

function messageText(body: ResponsesBody): string {
  if (typeof body.output_text === "string") return body.output_text;
  const texts: string[] = [];
  for (const item of body.output ?? []) {
    if (item.type !== "message") continue;
    if (typeof item.content === "string") {
      texts.push(item.content);
      continue;
    }
    if (!Array.isArray(item.content)) continue;
    for (const part of item.content as ResponseContentPart[]) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
  }
  return texts.join("");
}

async function readBounded(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderCallError("malformed");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderCallError("malformed");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function safeId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_ID.test(value) ? value : undefined;
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export function providerFailure(error: unknown): ServiceError {
  if (error instanceof ProviderCallError && error.reason === "timeout") {
    return new ServiceError(504, "PROVIDER_TIMEOUT", true);
  }
  return new ServiceError(502, "SUMMARIZATION_FAILED", true);
}
