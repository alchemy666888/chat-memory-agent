# Shared contract v1

This document is the integration contract for chat-memory-agent, chat-memory-mcp, and agent-bot. Keep its names, meanings, limits, and examples identical across those repositories.

## Confirmed behavior

- Both incoming user text and successfully delivered assistant answers are raw messages with explicit `user` or `assistant` roles.
- There is one cumulative summary per Telegram chat, updated from the previous summary and newly selected pending messages.
- The stored summary is at most **8,000 Unicode code points**, prioritizing important information, recent context, and recurring information. Count code points, not UTF-16 code units or bytes.
- For normal replies, use the summary plus the latest **50 pending raw messages**, with at most **24,000 code points of raw content**, followed by the current user message exactly once.
- Incoming-message saves start asynchronously. The reply path does not await save acceptance, the HTTP response, or database persistence.
- Memory retrieval is awaited, has one deadline, and is **never retried**. Failure, timeout, malformed output, or missing configuration causes a current-message-only reply attempt.
- Assistant answers are saved asynchronously only after the complete Telegram answer has been delivered successfully.
- Summarization starts only through an authenticated external processing REST call. There are no cron jobs, polling workers, startup processing, database-triggered processing, or processing calls from normal Telegram handling.
- A processing call takes **no chat ID**, automatically selects at most one eligible chat, and handles a bounded batch from that chat. It never moves on to another chat in the same call.
- A successful processing operation atomically updates that chat's summary and marks only its captured batch processed. Unselected messages and later arrivals remain pending.
- Keep processed raw rows; exclude them from ordinary pending retrieval. No retention purge or historical backfill is in scope.

## Engineering defaults

| Setting                           | Default                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform                          | Separate Vercel Next.js projects, Node.js runtime, TypeScript ESM                                                                                                                                |
| Existing stack baseline           | pnpm 10.28.1; Next.js 16.3.5 family; React/React DOM 19.3.0 family; TypeScript 6.0.2 family; pg 8.23.0 family; Zod 4.6.5 family; Vitest 5.0.1 family; ESLint/Prettier conventions from agent-bot |
| Node.js                           | Node >= 22                                                                                                                                                                                       |
| Memory-read deadline in agent-bot | 2,000 ms total, including MCP discovery/connection and the one tool invocation                                                                                                                   |
| Background-save deadline          | 5,000 ms per POST, independent of the generation deadline; one attempt, no application retry                                                                                                     |
| Normal processing batch           | Oldest pending prefix, up to 100 rows and 64,000 code points of content                                                                                                                          |
| Processing request                | Synchronous result for this explicit call; 240-second application deadline within a 300-second function duration                                                                                 |
| Per-chat processing lease         | 330 seconds; database time and a random fencing token                                                                                                                                            |
| Summary model                     | `DEEPSEEK_SUMMARY_MODEL` defaults to `deepseek-v4-pro`; use DeepSeek directly                                                                                                                    |
| Summary generation                | Non-streaming, thinking disabled, no tools or web search; bounded output and validation                                                                                                          |
| Schema owner                      | chat-memory-agent owns initialization; chat-memory-mcp only reads                                                                                                                                |
| Empty processing queue            | HTTP 200, result `no_work`                                                                                                                                                                       |
| No eligible unlocked chat         | HTTP 200, result `no_eligible_chat`                                                                                                                                                              |
| Isolation                         | Separate Preview/test and Production databases or isolated schemas with separately scoped credentials                                                                                            |

## Authentication and environment ownership

All service calls use HTTPS and `Authorization: Bearer <token>`.

| Environment variable          | Set in                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `CHAT_MEMORY_INGEST_TOKEN`    | agent-bot and chat-memory-agent                                                              |
| `CHAT_MEMORY_READ_TOKEN`      | agent-bot and chat-memory-mcp                                                                |
| `CHAT_MEMORY_PROCESS_TOKEN`   | chat-memory-agent and the external operator/caller only                                      |
| `CHAT_MEMORY_ALLOWED_HOSTS`   | chat-memory-mcp                                                                              |
| `CHAT_MEMORY_ALLOWED_ORIGINS` | chat-memory-mcp                                                                              |
| `CHAT_MEMORY_INGEST_URL`      | agent-bot; full `/api/v1/messages` URL                                                       |
| `CHAT_MEMORY_MCP_URL`         | agent-bot; full `/api/mcp` URL                                                               |
| `DATABASE_URL`                | Both memory services, pointing to the same schema; separate read/write roles where available |
| `AIVEN_PG_CA`                 | Both memory services if a custom PostgreSQL CA is needed                                     |
| `DATABASE_MIGRATOR_URL`       | chat-memory-agent explicit schema initialization only                                        |
| `DEEPSEEK_API_KEY`            | agent-bot and chat-memory-agent; never chat-memory-mcp                                       |
| `DEEPSEEK_BASE_URL`           | The two DeepSeek callers; default `https://api.deepseek.com`                                 |
| `DEEPSEEK_SUMMARY_MODEL`      | chat-memory-agent only                                                                       |
| `CHAT_MEMORY_READ_TIMEOUT_MS` | agent-bot; default 2000                                                                      |
| `CHAT_MEMORY_SAVE_TIMEOUT_MS` | agent-bot; default 5000                                                                      |
| `MEMORY_PROCESS_TIMEOUT_MS`   | chat-memory-agent; default 240000                                                            |
| `MEMORY_BATCH_MAX_MESSAGES`   | chat-memory-agent; default 100, maximum 100                                                  |
| `MEMORY_BATCH_MAX_CHARACTERS` | chat-memory-agent; default 64000, maximum 64000                                              |
| `CHAT_MEMORY_RUNTIME_ROLE`    | chat-memory-agent initialization                                                             |
| `CHAT_MEMORY_MCP_ROLE`        | chat-memory-agent initialization                                                             |

The three tokens must be distinct. A save token cannot read memory or process it. A read token cannot save or process it. Do not forward the process token, database credentials, or tokens inside prompts or tool arguments.

## Raw-message ingestion REST API

`POST /api/v1/messages` belongs to chat-memory-agent and requires the ingest token.

```json
{
  "contract_version": 1,
  "telegram_chat_id": "123456789",
  "event_key": "tg:987654321:user",
  "turn_id": "tg:987654321",
  "source_update_id": "987654321",
  "source_message_id": "42",
  "role": "user",
  "content": "Please remember that I prefer concise replies.",
  "occurred_at": "2026-10-28T10:00:00.000Z"
}
```

For an answer, use `event_key=tg:<update_id>:assistant`, the same `turn_id`, role `assistant`, and the complete cleaned logical answer. `source_message_id` is nullable for assistant answers. This service accepts the event when `event_key` is exactly `turn_id + ":" + role`.

- New persisted row: HTTP 201 with `{"contract_version":1,"result":"stored","raw_message_id":"1"}`.
- Exact replay: HTTP 200, result `duplicate`, with the existing row ID. Timestamp differences alone do not change the stored row.
- The same chat/event key with different role, content, turn, or source identity: HTTP 409, code `IDEMPOTENCY_CONFLICT`.
- Invalid payload: 400 `INVALID_INPUT`. Unauthenticated: 401 `UNAUTHORIZED`. Wrong recognized token scope: 403 `FORBIDDEN`. Unsupported media type: 415 `UNSUPPORTED_MEDIA_TYPE`. Oversized body: 413 `PAYLOAD_TOO_LARGE`. Database unavailable: 503 `DATABASE_UNAVAILABLE`.
- Error envelope: `{"contract_version":1,"error":{"code":"DATABASE_UNAVAILABLE","retryable":true},"request_id":"<opaque-id>"}`.
- A successful ingestion HTTP response means the row was committed. The bot does not wait for that response.
- The database accepts an assistant event even if its user event has not arrived yet.
- The application request body limit is 4 MiB. Telegram identifiers are decimal strings. Chat IDs are canonical signed nonzero decimal strings within PostgreSQL bigint range. `source_update_id` is a nonnegative decimal string. `source_message_id` is a nullable positive decimal string. `occurred_at` is an RFC 3339 timestamp with a `Z` or numeric offset.

## Memory-read MCP API

chat-memory-mcp exposes `POST /api/mcp` with one tool, `get_chat_memory`. This repository does not implement that endpoint. It stores the rows that tool reads.

Tool arguments:

```json
{
  "telegram_chat_id": "123456789",
  "exclude_turn_id": "tg:987654321"
}
```

`exclude_turn_id` is required for bot requests and optional for other authenticated service callers. Exclude all raw rows for that turn before applying window limits.

### Successful tool structuredContent

```json
{
  "contract_version": 1,
  "telegram_chat_id": "123456789",
  "summary": {
    "text": "The user prefers concise replies.",
    "version": "3",
    "updated_at": "2026-10-28T10:05:00.000Z"
  },
  "pending_messages": [
    {
      "raw_message_id": "91",
      "event_key": "tg:987654320:user",
      "turn_id": "tg:987654320",
      "source_update_id": "987654320",
      "role": "user",
      "content": "Use a friendly tone.",
      "occurred_at": "2026-10-28T10:04:00.000Z",
      "content_truncated": false
    }
  ],
  "window": {
    "returned_messages": 1,
    "returned_characters": 20,
    "has_more_pending": false
  }
}
```

`returned_characters` is the code-point length of `"Use a friendly tone."`, which is 20. A version-0 parent that has never been summarized is exposed as summary `null`. Unknown chat: summary null and pending messages empty. Read the summary and pending rows from one database snapshot. Chronological order is `occurred_at`, `source_update_id`, user before assistant, then `raw_message_id`. Select the newest 50 eligible pending rows, apply the 24,000-code-point budget as a contiguous newest window, and return them chronologically. One individually oversized newest message may return its first 24,000 code points with `content_truncated` true. Never include processed raw rows. Do not alter rows when clipping a read response.

## External processing REST API

`POST /api/v1/memory/process` belongs to chat-memory-agent, requires the process token, and accepts an empty JSON object. Reject chat IDs and any other body field.

```json
{
  "contract_version": 1,
  "result": "processed",
  "telegram_chat_id": "123456789",
  "processed_messages": 37,
  "summary_version": "4",
  "has_more_pending": true
}
```

No work: `{"contract_version":1,"result":"no_work","processed_messages":0}`. If pending chats exist but all have active leases or locked parents, return `{"contract_version":1,"result":"no_eligible_chat","processed_messages":0}`. An actual model call must not occur for either idle result.

A failure before final commit returns a 5xx error and leaves the captured raw rows pending and the previous summary intact. Processing failures use the same error envelope. `SUMMARIZATION_FAILED` and `PROVIDER_TIMEOUT` are retryable by a later explicit call. `DEADLINE_EXCEEDED` is retryable. `FENCE_REJECTED` means this request no longer owns the lease or version. `BATCH_EXCEEDS_EXCHANGE_BUDGET` means the captured row cannot be consumed within 16 exchanges. `COMMIT_OUTCOME_UNKNOWN` means the connection was lost while COMMIT was being acknowledged: the transaction may already have committed. Do not assert rollback and do not automatically retry processing.

Manual trigger, with the token supplied by the environment and never written into the command history as a literal secret:

```bash
curl -sS -X POST "$CHAT_MEMORY_PROCESS_URL" \
  -H "authorization: Bearer $CHAT_MEMORY_PROCESS_TOKEN" \
  -H "content-type: application/json" \
  --data '{}'
```

The caller's HTTP timeout must exceed the 240-second application budget. A lost HTTP response does not prove that no commit occurred.

## Relational schema

Schema `chat_memory`. Tables `chat_memory.chat_memories` and `chat_memory.raw_messages`.

`chat_memories` stores `telegram_chat_id` text primary key, `summary_text` text not null default empty with `char_length <= 8000`, `summary_version` bigint not null default 0, `created_at`, `updated_at`, nullable `summarized_at`, and a nullable uuid `processing_token` paired with `processing_lease_expires_at`.

`raw_messages` stores an identity `raw_message_id`, a foreign key to the parent, unique `(telegram_chat_id, event_key)`, `turn_id`, nonnegative `source_update_id`, nullable positive `source_message_id`, role `user` or `assistant`, nonempty `content`, `occurred_at`, `received_at`, status `non-process` or `processed-completed`, and completion metadata that is null exactly while the row is pending. Completed rows store `processed_summary_version > 0`. There is no foreign key from that historical version to the current summary version.

Pending indexes support per-chat chronological order, oldest-chat selection by `received_at` then numeric chat ID, and exclusion by turn. Initialization is explicit through `pnpm db:init`. There is no down migration.
