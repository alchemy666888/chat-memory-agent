import { z } from "zod";
import { ServiceError } from "../http/errors";

export const CONTRACT_VERSION = 1 as const;
export const SUMMARY_MAX_CODE_POINTS = 8_000;
export const SUMMARY_TARGET_CODE_POINTS = 7_000;
export const CHUNK_MAX_CODE_POINTS = 32_000;
export const MAX_PROVIDER_EXCHANGES = 16;
export const MAX_COMPRESSION_EXCHANGES = 1;
export const PROCESS_DEADLINE_MS = 240_000;
export const EXCHANGE_TIMEOUT_MS = 90_000;
export const FINALIZE_RESERVE_MS = 5_000;
export const LEASE_SECONDS = 330;
export const REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_OUTPUT_TOKENS = 8_192;
export const POOL_MAX = 3;
export const DEFAULT_BATCH_MAX_MESSAGES = 100;
export const DEFAULT_BATCH_MAX_CHARACTERS = 64_000;

const BIGINT_MIN = -9_223_372_036_854_775_808n;
const BIGINT_MAX = 9_223_372_036_854_775_807n;

export function codePointLength(value: string): number {
  return Array.from(value).length;
}

export function sliceCodePoints(
  value: string,
  start: number,
  end: number,
): string {
  return [...value].slice(start, end).join("");
}

export type MessageRole = "user" | "assistant";

export type IngestInput = {
  telegramChatId: string;
  eventKey: string;
  turnId: string;
  sourceUpdateId: string;
  sourceMessageId: string | null;
  role: MessageRole;
  content: string;
  occurredAt: string;
};

export type CapturedMessage = {
  rawMessageId: string;
  telegramChatId: string;
  eventKey: string;
  turnId: string;
  sourceUpdateId: string;
  role: MessageRole;
  content: string;
  occurredAt: string;
};

const ingestObject = z.strictObject({
  contract_version: z.literal(1),
  telegram_chat_id: z.string(),
  event_key: z.string(),
  turn_id: z.string(),
  source_update_id: z.string(),
  source_message_id: z.string().nullable().optional(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  occurred_at: z.string(),
});

function invalid(): never {
  throw new ServiceError(400, "INVALID_INPUT", false);
}

function parseDecimal(
  value: string,
  kind: "chat" | "nonnegative" | "positive",
): string {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) invalid();
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    invalid();
  }
  if (parsed < BIGINT_MIN || parsed > BIGINT_MAX) invalid();
  if (kind === "chat" && parsed === 0n) invalid();
  if (kind === "nonnegative" && parsed < 0n) invalid();
  if (kind === "positive" && parsed <= 0n) invalid();
  if (parsed.toString() !== value) invalid();
  return value;
}

function parseOccurredAt(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) invalid();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    invalid();
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    invalid();
  }
  return value;
}

function requireText(value: string, max: number): string {
  if (value.length === 0 || value.length > max || value.includes("\u0000"))
    invalid();
  return value;
}

export function parseIngestBody(input: unknown): IngestInput {
  const parsed = ingestObject.safeParse(input);
  if (!parsed.success) invalid();
  const body = parsed.data;
  const role = body.role;
  const turnId = requireText(body.turn_id, 256);
  const eventKey = requireText(body.event_key, 256);
  if (eventKey !== `${turnId}:${role}`) invalid();
  if (body.content.length === 0 || body.content.includes("\u0000")) invalid();
  if (codePointLength(body.content) < 1) invalid();
  const sourceMessageId =
    body.source_message_id === undefined || body.source_message_id === null
      ? null
      : parseDecimal(body.source_message_id, "positive");
  return {
    telegramChatId: parseDecimal(body.telegram_chat_id, "chat"),
    eventKey,
    turnId,
    sourceUpdateId: parseDecimal(body.source_update_id, "nonnegative"),
    sourceMessageId,
    role,
    content: body.content,
    occurredAt: parseOccurredAt(body.occurred_at),
  };
}

export function parseProcessBody(input: unknown): Record<string, never> {
  const parsed = z.strictObject({}).safeParse(input);
  if (!parsed.success) invalid();
  return parsed.data;
}

export type ProcessSuccess = {
  contract_version: 1;
  result: "processed";
  telegram_chat_id: string;
  processed_messages: number;
  summary_version: string;
  has_more_pending: boolean;
};

export type ProcessIdle = {
  contract_version: 1;
  result: "no_work" | "no_eligible_chat";
  processed_messages: 0;
};

export type ProcessResponse = ProcessSuccess | ProcessIdle;

export function sameStoredIdentity(
  existing: {
    role: string;
    content: string;
    turnId: string;
    sourceUpdateId: string;
    sourceMessageId: string | null;
  },
  input: IngestInput,
): boolean {
  return (
    existing.role === input.role &&
    existing.content === input.content &&
    existing.turnId === input.turnId &&
    existing.sourceUpdateId === input.sourceUpdateId &&
    existing.sourceMessageId === input.sourceMessageId
  );
}
