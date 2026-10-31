import "server-only";
import {
  CHUNK_MAX_CODE_POINTS,
  codePointLength,
  MAX_COMPRESSION_EXCHANGES,
  MAX_PROVIDER_EXCHANGES,
  sliceCodePoints,
  SUMMARY_MAX_CODE_POINTS,
  type CapturedMessage,
} from "../chat-memory/contracts";
import { ServiceError } from "../http/errors";
import {
  providerFailure,
  ProviderCallError,
  type ModelCompletion,
  type ModelExchange,
} from "./client";
import {
  COMPRESSION_INSTRUCTIONS,
  SUMMARY_INSTRUCTIONS,
  untrustedDataEnvelope,
  type PromptMessage,
} from "./prompt";

export type SummaryModel = {
  complete(exchange: ModelExchange): Promise<ModelCompletion>;
};

export type DeadlineBudget = {
  nextExchangeTimeoutMs(): number;
  remainingMs(): number;
  reserveMs: number;
};

export type ContentPiece = PromptMessage;

export function buildContentChunks(
  messages: CapturedMessage[],
  chunkLimit = CHUNK_MAX_CODE_POINTS,
): ContentPiece[][] {
  const pieces: ContentPiece[] = [];
  for (const message of messages) {
    const length = codePointLength(message.content);
    const parts = Math.max(1, Math.ceil(length / chunkLimit));
    for (let index = 0; index < parts; index += 1) {
      pieces.push({
        raw_message_id: message.rawMessageId,
        role: message.role,
        occurred_at: message.occurredAt,
        event_key: message.eventKey,
        turn_id: message.turnId,
        part: index + 1,
        parts,
        content: sliceCodePoints(
          message.content,
          index * chunkLimit,
          (index + 1) * chunkLimit,
        ),
      });
    }
  }
  const chunks: ContentPiece[][] = [];
  let current: ContentPiece[] = [];
  let used = 0;
  for (const piece of pieces) {
    const length = codePointLength(piece.content);
    if (current.length > 0 && used + length > chunkLimit) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(piece);
    used += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function summarizeBatch(options: {
  previousSummary: string;
  messages: CapturedMessage[];
  model: SummaryModel;
  deadline: DeadlineBudget;
  chunkLimit?: number;
  onExchange?: (event: {
    exchanges: number;
    providerRequestId?: string;
  }) => void;
}): Promise<{
  text: string;
  exchanges: number;
  chunkCount: number;
  model?: string;
}> {
  const chunks = buildContentChunks(options.messages, options.chunkLimit);
  if (chunks.length === 0) {
    throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
  }
  if (chunks.length > MAX_PROVIDER_EXCHANGES) {
    throw new ServiceError(502, "BATCH_EXCEEDS_EXCHANGE_BUDGET", true);
  }
  let working = options.previousSummary;
  let exchanges = 0;
  let repairs = 0;
  let modelName: string | undefined;
  for (const chunk of chunks) {
    const produced = await oneExchange({
      instructions: SUMMARY_INSTRUCTIONS,
      data: untrustedDataEnvelope({
        previous_summary: working,
        messages: chunk,
      }),
      model: options.model,
      deadline: options.deadline,
      exchanges,
      onExchange: options.onExchange,
    });
    exchanges = produced.exchanges;
    modelName = produced.completion.model;
    let text = acceptCompleted(produced.completion);
    if (codePointLength(text.trim()) > SUMMARY_MAX_CODE_POINTS) {
      if (
        repairs >= MAX_COMPRESSION_EXCHANGES ||
        exchanges >= MAX_PROVIDER_EXCHANGES
      ) {
        throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
      }
      const compressed = await oneExchange({
        instructions: COMPRESSION_INSTRUCTIONS,
        data: untrustedDataEnvelope({ over_limit_summary: text.trim() }),
        model: options.model,
        deadline: options.deadline,
        exchanges,
        onExchange: options.onExchange,
      });
      exchanges = compressed.exchanges;
      repairs += 1;
      modelName = compressed.completion.model;
      text = acceptCompleted(compressed.completion);
      if (codePointLength(text.trim()) > SUMMARY_MAX_CODE_POINTS) {
        throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
      }
    }
    working = text.trim();
  }
  if (working.length === 0)
    throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
  return {
    text: working,
    exchanges,
    chunkCount: chunks.length,
    ...(modelName ? { model: modelName } : {}),
  };
}

function acceptCompleted(completion: ModelCompletion): string {
  if (!completion.completed) {
    throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
  }
  if (completion.text.trim().length === 0) {
    throw new ServiceError(502, "SUMMARIZATION_FAILED", true);
  }
  return completion.text;
}

async function oneExchange(options: {
  instructions: string;
  data: string;
  model: SummaryModel;
  deadline: DeadlineBudget;
  exchanges: number;
  onExchange?: (event: {
    exchanges: number;
    providerRequestId?: string;
  }) => void;
}): Promise<{ completion: ModelCompletion; exchanges: number }> {
  if (options.exchanges >= MAX_PROVIDER_EXCHANGES) {
    throw new ServiceError(502, "BATCH_EXCEEDS_EXCHANGE_BUDGET", true);
  }
  const timeoutMs = options.deadline.nextExchangeTimeoutMs();
  let completion: ModelCompletion;
  try {
    completion = await options.model.complete({
      instructions: options.instructions,
      data: options.data,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof ProviderCallError && error.reason === "timeout") {
      if (options.deadline.remainingMs() <= options.deadline.reserveMs) {
        throw new ServiceError(504, "DEADLINE_EXCEEDED", true);
      }
    }
    throw error instanceof ServiceError ? error : providerFailure(error);
  }
  const exchanges = options.exchanges + 1;
  options.onExchange?.({
    exchanges,
    ...(completion.providerRequestId
      ? { providerRequestId: completion.providerRequestId }
      : {}),
  });
  return { completion, exchanges };
}
