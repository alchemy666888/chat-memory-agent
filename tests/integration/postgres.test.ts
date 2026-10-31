import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { Pool, type PoolClient } from "pg";
import { postMessages } from "../../src/app/api/v1/messages/route";
import { postProcess } from "../../src/app/api/v1/memory/process/route";
import { GET as getHealth } from "../../src/app/api/health/route";
import { claimOneChat } from "../../src/server/chat-memory/claim";
import { finalizeClaim } from "../../src/server/chat-memory/finalize";
import { ingestMessage } from "../../src/server/chat-memory/ingestion";
import { processNextChat } from "../../src/server/chat-memory/process";
import { parseIngestBody } from "../../src/server/chat-memory/contracts";
import { ProviderCallError } from "../../src/server/deepseek/client";
import { createPool, withTransaction } from "../../src/server/postgres/client";

const exec = promisify(execFile);
const MIGRATOR_URL =
  "postgres://postgres:migrator-test-password@127.0.0.1:5432/chat_memory_test";
const RUNTIME_URL =
  "postgres://chat_memory_app:app-test-password@127.0.0.1:5432/chat_memory_test";
const MCP_URL =
  "postgres://chat_memory_mcp:mcp-test-password@127.0.0.1:5432/chat_memory_test";
const INGEST = "ingest-token-0123456789abcdef";
const PROCESS = "process-token-0123456789abcde";
const READ = "read-token-0123456789abcdefgh";

const migrator = new Pool({ connectionString: MIGRATOR_URL, max: 3 });
const runtimeConfig = { DATABASE_URL: RUNTIME_URL, AIVEN_PG_CA: undefined };
const runtime = createPool(runtimeConfig);
const runtimeTwo = createPool(runtimeConfig);
const mcp = new Pool({ connectionString: MCP_URL, max: 1 });

function message(overrides: Record<string, unknown> = {}) {
  return {
    contract_version: 1,
    telegram_chat_id: "123456789",
    event_key: "tg:100:user",
    turn_id: "tg:100",
    source_update_id: "100",
    source_message_id: "50",
    role: "user",
    content: "Please remember that I prefer concise replies.",
    occurred_at: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

async function initDatabase(url = MIGRATOR_URL) {
  await exec("node", ["scripts/db-init.mjs"], {
    env: {
      ...process.env,
      DATABASE_MIGRATOR_URL: url,
      CHAT_MEMORY_RUNTIME_ROLE: "chat_memory_app",
      CHAT_MEMORY_MCP_ROLE: "chat_memory_mcp",
    },
  });
}

beforeAll(async () => {
  process.env.DATABASE_URL = RUNTIME_URL;
  process.env.CHAT_MEMORY_INGEST_TOKEN = INGEST;
  process.env.CHAT_MEMORY_PROCESS_TOKEN = PROCESS;
  process.env.CHAT_MEMORY_READ_TOKEN = READ;
  process.env.DEEPSEEK_API_KEY = "test-key";
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com";
  process.env.DEEPSEEK_SUMMARY_MODEL = "deepseek-v4-pro";
  await initDatabase();
  await initDatabase();
});

beforeEach(async () => {
  await migrator.query(
    "TRUNCATE chat_memory.raw_messages, chat_memory.chat_memories RESTART IDENTITY",
  );
});

afterAll(async () => {
  await migrator.end();
  await runtime.end();
  await runtimeTwo.end();
  await mcp.end();
});

describe("PostgreSQL ingestion and processing", () => {
  test("stores both roles, accepts assistant-first delivery, and keeps duplicates immutable", async () => {
    const assistant = await postJson(
      "/api/v1/messages",
      message({
        role: "assistant",
        event_key: "tg:100:assistant",
        source_message_id: null,
        content: "A concise acknowledgement.",
        occurred_at: "2026-10-28T10:00:01.000Z",
      }),
      INGEST,
    );
    expect(assistant.status).toBe(201);
    const user = await postJson("/api/v1/messages", message(), INGEST);
    expect(user.status).toBe(201);
    const replay = await Promise.all([
      ingestMessage(runtime, parseIngestBody(message())),
      ingestMessage(runtimeTwo, parseIngestBody(message())),
    ]);
    expect(replay.map((item) => item.result).sort()).toEqual([
      "duplicate",
      "duplicate",
    ]);
    const changed = await postJson(
      "/api/v1/messages",
      message({ content: "A different fact." }),
      INGEST,
    );
    expect(changed.status).toBe(409);
    await expect(changed.json()).resolves.toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT", retryable: false },
    });
    const rows = await migrator.query<{
      role: string;
      content: string;
      status: string;
    }>(
      "SELECT role, content, status FROM chat_memory.raw_messages ORDER BY raw_message_id",
    );
    expect(rows.rows).toEqual([
      {
        role: "assistant",
        content: "A concise acknowledgement.",
        status: "non-process",
      },
      {
        role: "user",
        content: "Please remember that I prefer concise replies.",
        status: "non-process",
      },
    ]);
    const originalTime = await migrator.query<{ occurred_at: Date }>(
      "SELECT occurred_at FROM chat_memory.raw_messages WHERE event_key = 'tg:100:user'",
    );
    const duplicate = await ingestMessage(
      runtime,
      parseIngestBody(message({ occurred_at: "2026-10-28T11:00:00.000Z" })),
    );
    expect(duplicate.result).toBe("duplicate");
    const after = await migrator.query<{ occurred_at: Date }>(
      "SELECT occurred_at FROM chat_memory.raw_messages WHERE event_key = 'tg:100:user'",
    );
    expect(after.rows[0]?.occurred_at.toISOString()).toBe(
      originalTime.rows[0]?.occurred_at.toISOString(),
    );
  });

  test("keeps bigint values as strings and enforces the summary length in the database", async () => {
    await ingestMessage(
      runtime,
      parseIngestBody(
        message({
          telegram_chat_id: "9223372036854775807",
          source_update_id: "9223372036854775807",
          event_key: "tg:9223372036854775807:user",
          turn_id: "tg:9223372036854775807",
        }),
      ),
    );
    const selected = await runtime.query<{ source_update_id: string }>(
      "SELECT source_update_id FROM chat_memory.raw_messages",
    );
    expect(typeof selected.rows[0]?.source_update_id).toBe("string");
    expect(selected.rows[0]?.source_update_id).toBe("9223372036854775807");
    const emoji = `${"a".repeat(7999)}👍`;
    await migrator.query(
      "UPDATE chat_memory.chat_memories SET summary_text = $1",
      [emoji],
    );
    await expect(
      migrator.query("UPDATE chat_memory.chat_memories SET summary_text = $1", [
        `${"a".repeat(8000)}👍`,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  test("an empty queue does no model work and an active lease is not eligible", async () => {
    const calls: string[] = [];
    const idle = await processNextChat(processor(calls));
    expect(idle).toMatchObject({ result: "no_work", processed_messages: 0 });
    expect(calls).toHaveLength(0);
    await ingestMessage(runtime, parseIngestBody(message()));
    await migrator.query(
      `UPDATE chat_memory.chat_memories
       SET processing_token = gen_random_uuid(),
           processing_lease_expires_at = clock_timestamp() + interval '10 minutes'`,
    );
    const blocked = await processNextChat(processor(calls));
    expect(blocked.result).toBe("no_eligible_chat");
    expect(calls).toHaveLength(0);
  });

  test("one request processes one captured batch and leaves a later arrival pending", async () => {
    await ingestMessage(
      runtime,
      parseIngestBody(message({ content: "Fact one." })),
    );
    await ingestMessage(
      runtime,
      parseIngestBody(
        message({
          event_key: "tg:101:user",
          turn_id: "tg:101",
          source_update_id: "101",
          content: "Fact two that should wait.",
          occurred_at: "2026-10-28T10:05:00.000Z",
        }),
      ),
    );
    process.env.MEMORY_BATCH_MAX_MESSAGES = "1";
    let inserted = false;
    try {
      const response = await postProcess(processRequest(), {
        pool: runtime,
        complete: async () => {
          if (!inserted) {
            inserted = true;
            const held = await migrator.connect();
            try {
              await held.query("BEGIN");
              await held.query(
                `INSERT INTO chat_memory.raw_messages (
                 telegram_chat_id, event_key, turn_id, source_update_id, role, content, occurred_at
               ) VALUES ('123456789', 'tg:300:user', 'tg:300', 300, 'user', 'Held until commit.', '2026-10-28T10:06:00Z')`,
              );
              await ingestMessage(
                runtimeTwo,
                parseIngestBody(
                  message({
                    event_key: "tg:301:assistant",
                    turn_id: "tg:301",
                    source_update_id: "301",
                    source_message_id: null,
                    role: "assistant",
                    content: "Visible before the held row.",
                    occurred_at: "2026-10-28T10:07:00.000Z",
                  }),
                ),
              );
              await held.query("COMMIT");
            } finally {
              held.release();
            }
          }
          return {
            text: "The user shared fact one.",
            completed: true,
            model: "fake",
          };
        },
        chunkLimit: 10_000,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: "processed",
        processed_messages: 1,
        summary_version: "1",
        has_more_pending: true,
      });
      const pending = await migrator.query<{ event_key: string }>(
        "SELECT event_key FROM chat_memory.raw_messages WHERE status = 'non-process' ORDER BY event_key",
      );
      expect(pending.rows.map((row) => row.event_key)).toEqual([
        "tg:101:user",
        "tg:300:user",
        "tg:301:assistant",
      ]);
      const replay = await ingestMessage(
        runtime,
        parseIngestBody(message({ content: "Fact one." })),
      );
      expect(replay.result).toBe("duplicate");
      const status = await migrator.query<{
        status: string;
        processed_summary_version: string;
      }>(
        "SELECT status, processed_summary_version::text AS processed_summary_version FROM chat_memory.raw_messages WHERE event_key = 'tg:100:user'",
      );
      expect(status.rows[0]).toEqual({
        status: "processed-completed",
        processed_summary_version: "1",
      });
    } finally {
      delete process.env.MEMORY_BATCH_MAX_MESSAGES;
    }
  });

  test("rolls back a summary when captured rows cannot be completed", async () => {
    await ingestMessage(runtime, parseIngestBody(message()));
    const claim = await withTransaction(runtime, (client) =>
      claimOneChat(client, { maxMessages: 100, maxCharacters: 64_000 }),
    );
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") return;
    await expect(
      withTransaction(runtime, (client) =>
        finalizeClaim(
          client,
          {
            telegramChatId: claim.telegramChatId,
            token: claim.processingToken,
            summaryVersion: claim.summaryVersion,
            summaryText: "This must roll back.",
            captured: claim.captured,
          },
          {
            afterSummaryUpdate: async () => {
              throw new Error("injected");
            },
          },
        ),
      ),
    ).rejects.toThrow("injected");
    const parent = await migrator.query<{
      summary_text: string;
      summary_version: string;
    }>(
      "SELECT summary_text, summary_version::text AS summary_version FROM chat_memory.chat_memories",
    );
    expect(parent.rows[0]).toEqual({ summary_text: "", summary_version: "0" });
    const raw = await migrator.query<{ status: string }>(
      "SELECT status FROM chat_memory.raw_messages",
    );
    expect(raw.rows[0]?.status).toBe("non-process");
  });

  test("an expired lease can be reclaimed and the old result cannot commit", async () => {
    await ingestMessage(runtime, parseIngestBody(message()));
    const first = await withTransaction(runtime, (client) =>
      claimOneChat(client, { maxMessages: 100, maxCharacters: 64_000 }),
    );
    if (first.kind !== "claimed") throw new Error("expected a claim");
    await migrator.query(
      "UPDATE chat_memory.chat_memories SET processing_lease_expires_at = clock_timestamp() - interval '1 second'",
    );
    const second = await withTransaction(runtime, (client) =>
      claimOneChat(client, { maxMessages: 100, maxCharacters: 64_000 }),
    );
    if (second.kind !== "claimed")
      throw new Error("expected the reclaimed chat");
    expect(second.processingToken).not.toBe(first.processingToken);
    await expect(
      withTransaction(runtime, (client) =>
        finalizeClaim(client, {
          telegramChatId: first.telegramChatId,
          token: first.processingToken,
          summaryVersion: first.summaryVersion,
          summaryText: "stale result",
          captured: first.captured,
        }),
      ),
    ).rejects.toMatchObject({ errorCode: "FENCE_REJECTED" });
    const token = await migrator.query<{
      processing_token: string;
      summary_text: string;
    }>(
      "SELECT processing_token::text AS processing_token, summary_text FROM chat_memory.chat_memories",
    );
    expect(token.rows[0]?.processing_token).toBe(second.processingToken);
    expect(token.rows[0]?.summary_text).toBe("");
  });

  test("concurrent triggers cannot own the same chat and can own different chats", async () => {
    await ingestMessage(runtime, parseIngestBody(message()));
    const [left, right] = await Promise.all([
      withTransaction(runtime, (client) =>
        claimOneChat(client, { maxMessages: 100, maxCharacters: 64_000 }),
      ),
      withTransaction(runtimeTwo, (client) =>
        claimOneChat(client, { maxMessages: 100, maxCharacters: 64_000 }),
      ),
    ]);
    const claimed = [left, right].filter((item) => item.kind === "claimed");
    expect(claimed).toHaveLength(1);
    expect([left, right].some((item) => item.kind === "no_eligible_chat")).toBe(
      true,
    );

    await migrator.query(
      "TRUNCATE chat_memory.raw_messages, chat_memory.chat_memories RESTART IDENTITY",
    );
    await ingestMessage(
      runtime,
      parseIngestBody(message({ content: "Chat A" })),
    );
    await ingestMessage(
      runtime,
      parseIngestBody(
        message({
          telegram_chat_id: "42",
          event_key: "tg:7:user",
          turn_id: "tg:7",
          source_update_id: "7",
          content: "Chat B",
        }),
      ),
    );
    const both = await Promise.all([
      withTransaction(runtime, (client) =>
        claimOneChat(client, { maxMessages: 100, maxCharacters: 64_000 }),
      ),
      withTransaction(runtimeTwo, (client) =>
        claimOneChat(client, { maxMessages: 100, maxCharacters: 64_000 }),
      ),
    ]);
    expect(both.every((item) => item.kind === "claimed")).toBe(true);
    const ids = both.map((item) =>
      item.kind === "claimed" ? item.telegramChatId : "",
    );
    expect(new Set(ids).size).toBe(2);
  });

  test("provider failure and an unfinished oversized row leave prior state pending", async () => {
    await ingestMessage(
      runtime,
      parseIngestBody(message({ content: "Keep me pending." })),
    );
    await expect(
      processNextChat({
        ...processor([]),
        complete: async () => {
          throw new ProviderCallError("http", 500);
        },
      }),
    ).rejects.toMatchObject({ errorCode: "SUMMARIZATION_FAILED" });
    const failed = await migrator.query<{
      summary_text: string;
      status: string;
      token: string | null;
    }>(
      `SELECT summary_text, status, processing_token::text AS token
       FROM chat_memory.chat_memories
       JOIN chat_memory.raw_messages USING (telegram_chat_id)`,
    );
    expect(failed.rows[0]).toMatchObject({
      summary_text: "",
      status: "non-process",
      token: null,
    });

    const parts: string[] = [];
    await expect(
      processNextChat({
        ...processor([]),
        chunkLimit: 4,
        complete: async (exchange) => {
          parts.push(exchange.data);
          if (parts.length === 2) throw new ProviderCallError("transport");
          return { text: "partial", completed: true, model: "fake" };
        },
      }),
    ).rejects.toMatchObject({ errorCode: "SUMMARIZATION_FAILED" });
    expect(parts.length).toBe(2);
    const still = await migrator.query<{
      status: string;
      summary_text: string;
    }>(
      `SELECT status, summary_text FROM chat_memory.raw_messages
       JOIN chat_memory.chat_memories USING (telegram_chat_id)`,
    );
    expect(still.rows[0]).toEqual({ status: "non-process", summary_text: "" });
  });

  test("a completed oversized row is chunked without dropping content", async () => {
    const content = "abcdefghij";
    await ingestMessage(runtime, parseIngestBody(message({ content })));
    const seen: string[] = [];
    const result = await processNextChat({
      ...processor([]),
      chunkLimit: 4,
      complete: async (exchange) => {
        seen.push(exchange.data);
        return {
          text: "All ten characters were read.",
          completed: true,
          model: "fake",
        };
      },
    });
    expect(result).toMatchObject({
      result: "processed",
      processed_messages: 1,
      summary_version: "1",
    });
    const pieces = seen.flatMap((data) => {
      const parsed = JSON.parse(data) as {
        untrusted_memory_data: { messages: { content: string }[] };
      };
      return parsed.untrusted_memory_data.messages.map((item) => item.content);
    });
    expect(pieces.join("")).toBe(content);
    expect(seen.length).toBeGreaterThan(1);
  });

  test("accepts an 8000-code-point summary and repairs 8001 once", async () => {
    await ingestMessage(runtime, parseIngestBody(message()));
    const exact = `${"a".repeat(7999)}👍`;
    const saved = await processNextChat({
      ...processor([]),
      complete: async () => ({ text: exact, completed: true, model: "fake" }),
    });
    expect(saved).toMatchObject({ result: "processed", summary_version: "1" });
    await migrator.query(
      "TRUNCATE chat_memory.raw_messages, chat_memory.chat_memories RESTART IDENTITY",
    );
    await ingestMessage(runtime, parseIngestBody(message()));
    let calls = 0;
    const repaired = await processNextChat({
      ...processor([]),
      complete: async () => {
        calls += 1;
        return {
          text: calls === 1 ? `${exact}b` : "Repaired memory.",
          completed: true,
          model: "fake",
        };
      },
    });
    expect(calls).toBe(2);
    expect(repaired).toMatchObject({ result: "processed" });
    const summary = await migrator.query<{ summary_text: string }>(
      "SELECT summary_text FROM chat_memory.chat_memories",
    );
    expect(summary.rows[0]?.summary_text).toBe("Repaired memory.");
  });

  test("authorization scope stops before SQL and health stays non-sensitive", async () => {
    const guarded = guardedPool();
    const missing = await postMessages(
      jsonRequest("/api/v1/messages", message(), ""),
      {
        pool: guarded.pool,
      },
    );
    expect(missing.status).toBe(401);
    const wrongScope = await postMessages(
      jsonRequest("/api/v1/messages", message(), PROCESS),
      { pool: guarded.pool },
    );
    expect(wrongScope.status).toBe(403);
    const processWithIngest = await postProcess(
      jsonRequest("/api/v1/memory/process", {}, INGEST),
      {
        pool: guarded.pool,
        complete: async () => {
          throw new Error("model reached");
        },
      },
    );
    expect(processWithIngest.status).toBe(403);
    const wrongType = await postMessages(
      new Request("http://localhost/api/v1/messages", {
        method: "POST",
        headers: {
          authorization: `Bearer ${INGEST}`,
          "content-type": "text/plain",
        },
        body: "{}",
      }),
      { pool: guarded.pool },
    );
    expect(wrongType.status).toBe(415);
    const namedChat = await postProcess(
      jsonRequest("/api/v1/memory/process", { telegram_chat_id: "1" }, PROCESS),
      {
        pool: guarded.pool,
        complete: async () => {
          throw new Error("model reached");
        },
      },
    );
    expect(namedChat.status).toBe(400);
    expect(guarded.connections).toBe(0);
    const health = await getHealth(new Request("http://localhost/api/health"));
    expect(health.status).toBe(200);
    const body = await health.json();
    expect(body).toEqual({ status: "ok" });
    expect(JSON.stringify(body)).not.toMatch(/postgres|token|secret/i);
  });

  test("a lost COMMIT acknowledgement is reported once and does not run the model again", async () => {
    await ingestMessage(runtime, parseIngestBody(message()));
    let calls = 0;
    let armed = false;
    const pool = createPool(runtimeConfig);
    const connect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await connect();
      const query = client.query.bind(client);
      client.query = (async (...args: Parameters<PoolClient["query"]>) => {
        const sql = args[0];
        if (armed && typeof sql === "string" && sql === "COMMIT") {
          armed = false;
          throw Object.assign(new Error("Connection terminated unexpectedly"), {
            code: "ECONNRESET",
          });
        }
        return query(...args);
      }) as PoolClient["query"];
      return client;
    };
    try {
      const response = await postProcess(processRequest(), {
        pool,
        complete: async () => {
          calls += 1;
          armed = true;
          return { text: "Committed or not.", completed: true, model: "fake" };
        },
      });
      expect(calls).toBe(1);
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "COMMIT_OUTCOME_UNKNOWN", retryable: false },
      });
    } finally {
      await pool.end();
    }
  });

  test("a repeatable-read snapshot does not observe a commit that starts later", async () => {
    await ingestMessage(runtime, parseIngestBody(message()));
    const reader = await mcp.connect();
    try {
      await reader.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const before = await reader.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM chat_memory.raw_messages",
      );
      await ingestMessage(
        runtime,
        parseIngestBody(
          message({
            event_key: "tg:8:user",
            turn_id: "tg:8",
            source_update_id: "8",
            content: "Arrived after the snapshot.",
          }),
        ),
      );
      const during = await reader.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM chat_memory.raw_messages",
      );
      expect(during.rows[0]?.count).toBe(before.rows[0]?.count);
      await reader.query("COMMIT");
    } finally {
      reader.release();
    }
  });

  test("runtime can write rows and neither runtime nor MCP can administer the schema", async () => {
    await expect(
      mcp.query("SELECT count(*) FROM chat_memory.chat_memories"),
    ).resolves.toBeTruthy();
    await expect(
      mcp.query(
        "INSERT INTO chat_memory.chat_memories (telegram_chat_id, created_at, updated_at) VALUES ('5', now(), now())",
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runtime.query("CREATE TABLE chat_memory.forbidden (id int)"),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await ingestMessage(
      runtime,
      parseIngestBody(
        message({
          telegram_chat_id: "5",
          event_key: "tg:5:user",
          turn_id: "tg:5",
          source_update_id: "5",
        }),
      ),
    );
    await expect(
      runtime.query("DELETE FROM chat_memory.raw_messages"),
    ).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("initializer compatibility", () => {
  test("a conflicting check fails the second initialization", async () => {
    const admin = new Pool({
      connectionString:
        "postgres://postgres:migrator-test-password@127.0.0.1:5432/postgres",
      max: 1,
    });
    await admin.query("DROP DATABASE IF EXISTS chat_memory_conflict");
    await admin.query("CREATE DATABASE chat_memory_conflict");
    await admin.end();
    const url = MIGRATOR_URL.replace(
      "/chat_memory_test",
      "/chat_memory_conflict",
    );
    await initDatabase(url);
    const client = new Pool({ connectionString: url, max: 1 });
    await client.query(
      "ALTER TABLE chat_memory.chat_memories DROP CONSTRAINT chat_memories_summary_length",
    );
    await client.query(
      "ALTER TABLE chat_memory.chat_memories ADD CONSTRAINT chat_memories_summary_length CHECK (char_length(summary_text) <= 9000)",
    );
    await client.end();
    await expect(initDatabase(url)).rejects.toMatchObject({ code: 1 });
  });
});

function processor(calls: string[]) {
  return {
    pool: runtime,
    requestId: "test-request",
    modelName: "fake",
    maxMessages: 100,
    maxCharacters: 64_000,
    deadlineMs: 240_000,
    complete: async () => {
      calls.push("model");
      return { text: "Summary", completed: true, model: "fake" };
    },
  };
}

function processRequest(): Request {
  return jsonRequest("/api/v1/memory/process", {}, PROCESS);
}

function jsonRequest(path: string, body: unknown, token: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function postJson(path: string, body: unknown, token: string) {
  return postMessages(jsonRequest(path, body, token), { pool: runtime });
}

function guardedPool(): { pool: Pool; readonly connections: number } {
  let connections = 0;
  return {
    get connections() {
      return connections;
    },
    pool: {
      connect: async () => {
        connections += 1;
        throw new Error("SQL was reached");
      },
    } as unknown as Pool,
  };
}
