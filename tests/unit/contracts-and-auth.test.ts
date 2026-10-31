import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { authenticateBearer, tokenEquals } from "../../src/server/auth/tokens";
import {
  codePointLength,
  parseIngestBody,
  parseProcessBody,
  sliceCodePoints,
} from "../../src/server/chat-memory/contracts";
import { readIngestConfig, readProcessConfig } from "../../src/server/config";
import { ServiceError } from "../../src/server/http/errors";
import { selectCapturedPrefix } from "../../src/server/chat-memory/repository";
import {
  normalizeCertificate,
  normalizePostgresUrl,
} from "../../src/server/postgres/config";
import { postgresPoolConfig } from "../../src/server/postgres/client";

const ingest = {
  contract_version: 1,
  telegram_chat_id: "123456789",
  event_key: "tg:987654321:user",
  turn_id: "tg:987654321",
  source_update_id: "987654321",
  source_message_id: "42",
  role: "user",
  content: "Please remember that I prefer concise replies.",
  occurred_at: "2026-10-28T10:00:00.000Z",
};

const baseEnv = {
  DATABASE_URL: "postgres://app:secret@db.example:5432/chat?sslmode=require",
  CHAT_MEMORY_INGEST_TOKEN: "ingest-token-0123456789abcdef",
  CHAT_MEMORY_PROCESS_TOKEN: "process-token-0123456789abcde",
  DEEPSEEK_API_KEY: "deepseek-test-key",
};

describe("wire contracts", () => {
  test("accepts the shared ingestion example and assistant-first shape", () => {
    const parsed = parseIngestBody(ingest);
    expect(parsed.telegramChatId).toBe("123456789");
    expect(parsed.sourceMessageId).toBe("42");
    const assistant = parseIngestBody({
      ...ingest,
      role: "assistant",
      event_key: "tg:987654321:assistant",
      source_message_id: null,
      content: "I will keep replies concise.",
    });
    expect(assistant.sourceMessageId).toBeNull();
  });

  test("rejects unknown process fields, bad ids, and non-canonical timestamps", () => {
    expect(parseProcessBody({})).toEqual({});
    expect(() => parseProcessBody({ telegram_chat_id: "1" })).toThrow(
      ServiceError,
    );
    expect(() => parseProcessBody([])).toThrow(ServiceError);
    expect(() => parseIngestBody({ ...ingest, contract_version: 2 })).toThrow(
      ServiceError,
    );
    expect(() => parseIngestBody({ ...ingest, extra: true })).toThrow(
      ServiceError,
    );
    expect(() => parseIngestBody({ ...ingest, telegram_chat_id: "0" })).toThrow(
      ServiceError,
    );
    expect(() =>
      parseIngestBody({ ...ingest, telegram_chat_id: "9223372036854775808" }),
    ).toThrow(ServiceError);
    expect(() =>
      parseIngestBody({ ...ingest, source_update_id: "-1" }),
    ).toThrow(ServiceError);
    expect(() => parseIngestBody({ ...ingest, event_key: "other" })).toThrow(
      ServiceError,
    );
    expect(() =>
      parseIngestBody({ ...ingest, occurred_at: "2026-02-31T00:00:00Z" }),
    ).toThrow(ServiceError);
    expect(() => parseIngestBody({ ...ingest, content: "" })).toThrow(
      ServiceError,
    );
    expect(
      parseIngestBody({ ...ingest, telegram_chat_id: "-9223372036854775808" })
        .telegramChatId,
    ).toBe("-9223372036854775808");
  });

  test("counts Unicode code points rather than UTF-16 units", () => {
    const emoji = "👍";
    expect(emoji.length).toBe(2);
    expect(codePointLength(emoji)).toBe(1);
    expect(sliceCodePoints(`${"a".repeat(3)}${emoji}z`, 3, 4)).toBe(emoji);
    expect(codePointLength(`${"a".repeat(7999)}${emoji}`)).toBe(8000);
  });

  test("captures an oversized oldest row alone and otherwise keeps a whole prefix", () => {
    const rows = ["tiny", "123456", "ok"].map((content, index) => ({
      rawMessageId: String(index + 1),
      telegramChatId: "1",
      eventKey: `tg:${index}:user`,
      turnId: `tg:${index}`,
      sourceUpdateId: String(index),
      role: "user" as const,
      content,
      occurredAt: "2026-10-28T10:00:00.000Z",
    }));
    expect(
      selectCapturedPrefix(rows, 100, 10).map((row) => row.rawMessageId),
    ).toEqual(["1", "2"]);
    expect(
      selectCapturedPrefix(
        [{ ...rows[1], content: "x".repeat(11) }, rows[2]],
        100,
        10,
      ),
    ).toHaveLength(1);
  });
});

describe("scoped configuration", () => {
  test("separates tokens and upgrades loose ssl modes", () => {
    const config = readProcessConfig(baseEnv);
    expect(config.DATABASE_URL).toContain("sslmode=verify-full");
    expect(config.DEEPSEEK_SUMMARY_MODEL).toBe("deepseek-v4-pro");
    expect(config.DEEPSEEK_BASE_URL).toBe("https://api.deepseek.com");
    expect(config.MEMORY_BATCH_MAX_MESSAGES).toBe(100);
    expect(() =>
      readIngestConfig({
        ...baseEnv,
        CHAT_MEMORY_PROCESS_TOKEN: baseEnv.CHAT_MEMORY_INGEST_TOKEN,
      }),
    ).toThrow(ServiceError);
    expect(() =>
      readProcessConfig({ ...baseEnv, MEMORY_BATCH_MAX_CHARACTERS: "64001" }),
    ).toThrow(ServiceError);
    expect(() =>
      readProcessConfig({ ...baseEnv, DEEPSEEK_API_KEY: "" }),
    ).toThrow(ServiceError);
    const preserved = normalizePostgresUrl(
      "postgres://db.example/chat?sslmode=require&uselibpqcompat=true",
    );
    expect(preserved).toContain("sslmode=require");
  });

  test("normalizes certificates and pins the CA on the pool", () => {
    const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
    expect(normalizeCertificate(pem.replace(/\n/g, "\\n"))).toBe(pem);
    expect(normalizeCertificate(Buffer.from(pem).toString("base64"))).toBe(pem);
    const pool = postgresPoolConfig(
      "postgres://db.example/chat?sslmode=require",
      pem,
    );
    expect(pool.connectionString).not.toContain("sslmode");
    expect(pool.ssl).toEqual({ ca: pem, rejectUnauthorized: true });
    expect(pool.max).toBe(3);
    const clientSource = readFileSync("src/server/postgres/client.ts", "utf8");
    expect(clientSource).not.toContain("setTypeParser");
    expect(clientSource).not.toContain("parseInt8");
  });

  test("bearer scope never confuses ingest and process tokens", () => {
    expect(tokenEquals("abc", "abc")).toBe(true);
    expect(tokenEquals("abc", "abd")).toBe(false);
    expect(() => authenticateBearer(null, "expected-token-value", [])).toThrow(
      ServiceError,
    );
    expect(() =>
      authenticateBearer(
        "Bearer process-token-0123456789abcde",
        baseEnv.CHAT_MEMORY_INGEST_TOKEN,
        [baseEnv.CHAT_MEMORY_PROCESS_TOKEN],
      ),
    ).toThrow(expect.objectContaining({ status: 403, errorCode: "FORBIDDEN" }));
    expect(() =>
      authenticateBearer(
        "Bearer missing-token-value",
        baseEnv.CHAT_MEMORY_INGEST_TOKEN,
        [baseEnv.CHAT_MEMORY_PROCESS_TOKEN],
      ),
    ).toThrow(
      expect.objectContaining({ status: 401, errorCode: "UNAUTHORIZED" }),
    );
    authenticateBearer(
      `Bearer ${baseEnv.CHAT_MEMORY_INGEST_TOKEN}`,
      baseEnv.CHAT_MEMORY_INGEST_TOKEN,
      [baseEnv.CHAT_MEMORY_PROCESS_TOKEN],
    );
  });
});
