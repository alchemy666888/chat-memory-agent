import { describe, expect, test } from "vitest";
import type { Pool } from "pg";
import { readJsonBody } from "../../src/server/http/body";
import {
  CommitOutcomeUnknownError,
  ServiceError,
} from "../../src/server/http/errors";
import { errorResponse } from "../../src/server/http/response";
import { withTransaction } from "../../src/server/postgres/client";

describe("request bounds", () => {
  test("rejects the wrong media type and a body over the declared limit", async () => {
    await expect(
      readJsonBody(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "{}",
        }),
        100,
      ),
    ).rejects.toMatchObject({
      status: 415,
      errorCode: "UNSUPPORTED_MEDIA_TYPE",
    });
    await expect(
      readJsonBody(
        new Request("http://localhost/api", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": "1000",
          },
          body: "{}",
        }),
        10,
      ),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      readJsonBody(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: "{",
        }),
        100,
      ),
    ).rejects.toBeInstanceOf(ServiceError);
    await expect(
      readJsonBody(
        new Request("http://localhost/api", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
        }),
        100,
      ),
    ).resolves.toEqual({ ok: true });
  });
});

describe("commit outcome", () => {
  test("classifies connection loss during COMMIT as unknown and rolls back earlier failures", async () => {
    const lost = fakePool(async (sql) => {
      if (sql === "COMMIT") {
        throw Object.assign(new Error("Connection terminated unexpectedly"), {
          code: "ECONNRESET",
        });
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(
      withTransaction(lost, async () => "done"),
    ).rejects.toBeInstanceOf(CommitOutcomeUnknownError);
    const calls: string[] = [];
    const failed = fakePool(async (sql) => {
      calls.push(sql);
      if (sql === "SELECT broken") throw new Error("statement failed");
      return { rows: [], rowCount: 0 };
    });
    await expect(
      withTransaction(failed, async (client) => {
        await client.query("SELECT broken");
      }),
    ).rejects.toThrow("statement failed");
    expect(calls).toContain("ROLLBACK");
    const response = errorResponse(new CommitOutcomeUnknownError(), "req-1");
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      contract_version: 1,
      error: { code: "COMMIT_OUTCOME_UNKNOWN", retryable: false },
      request_id: "req-1",
    });
  });
});

function fakePool(
  query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>,
): Pool {
  return {
    connect: async () => ({
      query: async (sql: string) => query(sql),
      release() {
        return undefined;
      },
    }),
  } as unknown as Pool;
}
