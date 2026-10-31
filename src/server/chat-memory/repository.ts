import type { Pool, PoolClient } from "pg";
import { ServiceError } from "../http/errors";
import {
  codePointLength,
  sameStoredIdentity,
  type CapturedMessage,
  type IngestInput,
  type MessageRole,
} from "./contracts";

type Queryable = Pick<Pool | PoolClient, "query">;

type ExistingRow = {
  raw_message_id: string;
  role: string;
  content: string;
  turn_id: string;
  source_update_id: string;
  source_message_id: string | null;
  status: string;
};

export type StoredMessage = {
  result: "stored" | "duplicate";
  rawMessageId: string;
};

export async function insertRawMessage(
  client: Queryable,
  input: IngestInput,
): Promise<StoredMessage> {
  await client.query(
    `INSERT INTO chat_memory.chat_memories (telegram_chat_id, created_at, updated_at)
     VALUES ($1, clock_timestamp(), clock_timestamp())
     ON CONFLICT (telegram_chat_id) DO NOTHING`,
    [input.telegramChatId],
  );
  const inserted = await client.query<{ raw_message_id: string }>(
    `INSERT INTO chat_memory.raw_messages (
       telegram_chat_id, event_key, turn_id, source_update_id, source_message_id,
       role, content, occurred_at
     ) VALUES (
       $1, $2, $3, $4::bigint, $5::bigint, $6, $7, $8::timestamptz
     )
     ON CONFLICT (telegram_chat_id, event_key) DO NOTHING
     RETURNING raw_message_id::text AS raw_message_id`,
    [
      input.telegramChatId,
      input.eventKey,
      input.turnId,
      input.sourceUpdateId,
      input.sourceMessageId,
      input.role,
      input.content,
      input.occurredAt,
    ],
  );
  const created = inserted.rows[0];
  if (created)
    return { result: "stored", rawMessageId: created.raw_message_id };

  const existing = await client.query<ExistingRow>(
    `SELECT raw_message_id::text AS raw_message_id,
            role,
            content,
            turn_id,
            source_update_id::text AS source_update_id,
            source_message_id::text AS source_message_id,
            status
     FROM chat_memory.raw_messages
     WHERE telegram_chat_id = $1 AND event_key = $2`,
    [input.telegramChatId, input.eventKey],
  );
  const row = existing.rows[0];
  if (!row) throw new ServiceError(503, "DATABASE_UNAVAILABLE", true);
  if (
    !sameStoredIdentity(
      {
        role: row.role,
        content: row.content,
        turnId: row.turn_id,
        sourceUpdateId: row.source_update_id,
        sourceMessageId: row.source_message_id,
      },
      input,
    )
  ) {
    throw new ServiceError(409, "IDEMPOTENCY_CONFLICT", false);
  }
  return { result: "duplicate", rawMessageId: row.raw_message_id };
}

export async function hasAnyPending(client: Queryable): Promise<boolean> {
  const result = await client.query<{ has_pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM chat_memory.raw_messages WHERE status = 'non-process'
     ) AS has_pending`,
  );
  return result.rows[0]?.has_pending === true;
}

export async function listPendingChats(
  client: Queryable,
): Promise<{ telegramChatId: string }[]> {
  const result = await client.query<{ telegram_chat_id: string }>(
    `SELECT telegram_chat_id
     FROM (
       SELECT telegram_chat_id, min(received_at) AS oldest_received_at
       FROM chat_memory.raw_messages
       WHERE status = 'non-process'
       GROUP BY telegram_chat_id
     ) pending_chats
     ORDER BY oldest_received_at ASC, telegram_chat_id::bigint ASC`,
  );
  return result.rows.map((row) => ({ telegramChatId: row.telegram_chat_id }));
}

export type LockedChat = {
  telegramChatId: string;
  summaryText: string;
  summaryVersion: string;
  leaseActive: boolean;
};

export async function lockChat(
  client: Queryable,
  telegramChatId: string,
): Promise<LockedChat | null> {
  const result = await client.query<{
    telegram_chat_id: string;
    summary_text: string;
    summary_version: string;
    lease_active: boolean;
  }>(
    `SELECT telegram_chat_id,
            summary_text,
            summary_version::text AS summary_version,
            (
              processing_token IS NOT NULL
              AND processing_lease_expires_at > clock_timestamp()
            ) AS lease_active
     FROM chat_memory.chat_memories
     WHERE telegram_chat_id = $1
     FOR UPDATE SKIP LOCKED`,
    [telegramChatId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    telegramChatId: row.telegram_chat_id,
    summaryText: row.summary_text,
    summaryVersion: requireBigintString(row.summary_version),
    leaseActive: row.lease_active,
  };
}

export async function listOldestPending(
  client: Queryable,
  telegramChatId: string,
  limit: number,
): Promise<CapturedMessage[]> {
  const result = await client.query<{
    raw_message_id: string;
    telegram_chat_id: string;
    event_key: string;
    turn_id: string;
    source_update_id: string;
    role: MessageRole;
    content: string;
    occurred_at: Date | string;
  }>(
    `SELECT raw_message_id::text AS raw_message_id,
            telegram_chat_id,
            event_key,
            turn_id,
            source_update_id::text AS source_update_id,
            role,
            content,
            occurred_at
     FROM chat_memory.raw_messages
     WHERE telegram_chat_id = $1 AND status = 'non-process'
     ORDER BY occurred_at ASC,
              source_update_id ASC,
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              raw_message_id ASC
     LIMIT $2`,
    [telegramChatId, limit],
  );
  return result.rows.map((row) => ({
    rawMessageId: requireBigintString(row.raw_message_id),
    telegramChatId: row.telegram_chat_id,
    eventKey: row.event_key,
    turnId: row.turn_id,
    sourceUpdateId: requireBigintString(row.source_update_id),
    role: row.role,
    content: row.content,
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
  }));
}

export function selectCapturedPrefix(
  rows: CapturedMessage[],
  maxMessages: number,
  maxCharacters: number,
): CapturedMessage[] {
  if (rows.length === 0) return [];
  const bounded = rows.slice(0, maxMessages);
  const first = bounded[0];
  if (!first) return [];
  if (codePointLength(first.content) > maxCharacters) return [first];
  const captured: CapturedMessage[] = [];
  let used = 0;
  for (const row of bounded) {
    const length = codePointLength(row.content);
    if (captured.length > 0 && used + length > maxCharacters) break;
    captured.push(row);
    used += length;
  }
  return captured;
}

export async function setProcessingLease(
  client: Queryable,
  telegramChatId: string,
  token: string,
  leaseSeconds: number,
): Promise<void> {
  const result = await client.query(
    `UPDATE chat_memory.chat_memories
     SET processing_token = $2::uuid,
         processing_lease_expires_at = clock_timestamp() + make_interval(secs => $3::int),
         updated_at = clock_timestamp()
     WHERE telegram_chat_id = $1
       AND (
         processing_token IS NULL
         OR processing_lease_expires_at <= clock_timestamp()
       )`,
    [telegramChatId, token, leaseSeconds],
  );
  if (result.rowCount !== 1)
    throw new ServiceError(500, "FENCE_REJECTED", false);
}

export async function clearProcessingLease(
  client: Queryable,
  telegramChatId: string,
  token: string,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE chat_memory.chat_memories
     SET processing_token = NULL,
         processing_lease_expires_at = NULL,
         updated_at = clock_timestamp()
     WHERE telegram_chat_id = $1
       AND processing_token = $2::uuid`,
    [telegramChatId, token],
  );
  return result.rowCount === 1;
}

export async function lockChatForFinalize(
  client: Queryable,
  telegramChatId: string,
): Promise<{
  summaryVersion: string;
  processingToken: string | null;
  leaseActive: boolean;
} | null> {
  const result = await client.query<{
    summary_version: string;
    processing_token: string | null;
    lease_active: boolean;
  }>(
    `SELECT summary_version::text AS summary_version,
            processing_token::text AS processing_token,
            (
              processing_token IS NOT NULL
              AND processing_lease_expires_at > clock_timestamp()
            ) AS lease_active
     FROM chat_memory.chat_memories
     WHERE telegram_chat_id = $1
     FOR UPDATE`,
    [telegramChatId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    summaryVersion: requireBigintString(row.summary_version),
    processingToken: row.processing_token,
    leaseActive: row.lease_active,
  };
}

export async function writeSummary(
  client: Queryable,
  input: {
    telegramChatId: string;
    token: string;
    summaryVersion: string;
    summaryText: string;
  },
): Promise<string> {
  const result = await client.query<{ summary_version: string }>(
    `UPDATE chat_memory.chat_memories
     SET summary_text = $4,
         summary_version = summary_version + 1,
         summarized_at = clock_timestamp(),
         updated_at = clock_timestamp(),
         processing_token = NULL,
         processing_lease_expires_at = NULL
     WHERE telegram_chat_id = $1
       AND processing_token = $2::uuid
       AND processing_lease_expires_at > clock_timestamp()
       AND summary_version = $3::bigint
     RETURNING summary_version::text AS summary_version`,
    [
      input.telegramChatId,
      input.token,
      input.summaryVersion,
      input.summaryText,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new ServiceError(500, "FENCE_REJECTED", false);
  return requireBigintString(row.summary_version);
}

export async function completeCapturedMessages(
  client: Queryable,
  input: {
    telegramChatId: string;
    rawMessageIds: string[];
    summaryVersion: string;
  },
): Promise<number> {
  const result = await client.query<{ raw_message_id: string }>(
    `UPDATE chat_memory.raw_messages
     SET status = 'processed-completed',
         processed_at = clock_timestamp(),
         processed_summary_version = $3::bigint
     WHERE telegram_chat_id = $1
       AND raw_message_id = ANY($2::bigint[])
       AND status = 'non-process'
     RETURNING raw_message_id::text AS raw_message_id`,
    [input.telegramChatId, input.rawMessageIds, input.summaryVersion],
  );
  return result.rows.length;
}

export async function chatHasPending(
  client: Queryable,
  telegramChatId: string,
): Promise<boolean> {
  const result = await client.query<{ has_pending: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM chat_memory.raw_messages
       WHERE telegram_chat_id = $1 AND status = 'non-process'
     ) AS has_pending`,
    [telegramChatId],
  );
  return result.rows[0]?.has_pending === true;
}

function requireBigintString(value: string): string {
  if (!/^-?(0|[1-9][0-9]*)$/.test(value)) {
    throw new ServiceError(500, "INTERNAL_ERROR", false);
  }
  return value;
}
