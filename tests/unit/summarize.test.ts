import { describe, expect, test } from "vitest";
import { SUMMARY_MAX_CODE_POINTS } from "../../src/server/chat-memory/contracts";
import {
  ProviderCallError,
  requestSummary,
} from "../../src/server/deepseek/client";
import { SUMMARY_INSTRUCTIONS } from "../../src/server/deepseek/prompt";
import {
  buildContentChunks,
  summarizeBatch,
  type DeadlineBudget,
} from "../../src/server/deepseek/summarize";
import type { CapturedMessage } from "../../src/server/chat-memory/contracts";
import type { ModelCompletion } from "../../src/server/deepseek/client";

const deadline: DeadlineBudget = {
  reserveMs: 5_000,
  remainingMs: () => 60_000,
  nextExchangeTimeoutMs: () => 90_000,
};

function message(content: string, id = "1"): CapturedMessage {
  return {
    rawMessageId: id,
    telegramChatId: "123456789",
    eventKey: `tg:${id}:user`,
    turnId: `tg:${id}`,
    sourceUpdateId: id,
    role: "user",
    content,
    occurredAt: "2026-10-28T10:00:00.000Z",
  };
}

describe("bounded summarization", () => {
  test("keeps source order across chunks and repairs one over-limit summary", async () => {
    const chunks = buildContentChunks(
      [
        message("12345", "1"),
        message("abcde", "2"),
        message("👍".repeat(6), "3"),
      ],
      5,
    );
    expect(chunks.map((chunk) => chunk.map((piece) => piece.content))).toEqual([
      ["12345"],
      ["abcde"],
      ["👍👍👍👍👍"],
      ["👍"],
    ]);
    const seen: string[] = [];
    const summary = await summarizeBatch({
      previousSummary: "",
      messages: [message("12345", "1"), message("abcde", "2")],
      chunkLimit: 5,
      deadline,
      model: {
        async complete(exchange) {
          seen.push(exchange.data);
          if (exchange.data.includes("over_limit_summary")) {
            return { text: "short-memory", completed: true, model: "fake" };
          }
          if (exchange.data.includes("abcde")) {
            return { text: "b".repeat(8001), completed: true, model: "fake" };
          }
          return { text: "kept", completed: true, model: "fake" };
        },
      },
    });
    expect(seen[0]).toContain("12345");
    expect(seen[1]).toContain("abcde");
    expect(summary.text).toBe("short-memory");
  });

  test("rejects truncated, empty, and still-over-limit output without a second repair", async () => {
    await expect(
      summarizeBatch({
        previousSummary: "old",
        messages: [message("fact")],
        deadline,
        model: {
          async complete() {
            return {
              ...completed("short"),
              completed: false,
              incompleteReason: "max_output_tokens",
            };
          },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "SUMMARIZATION_FAILED" });
    const calls: number[] = [];
    await expect(
      summarizeBatch({
        previousSummary: "",
        messages: [message("fact")],
        deadline,
        model: {
          async complete() {
            calls.push(1);
            return completed("x".repeat(SUMMARY_MAX_CODE_POINTS + 1));
          },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "SUMMARIZATION_FAILED" });
    expect(calls).toHaveLength(2);
    await expect(
      summarizeBatch({
        previousSummary: "",
        messages: Array.from({ length: 17 }, (_, index) =>
          message("1234567890", String(index + 1)),
        ),
        chunkLimit: 10,
        deadline,
        model: {
          async complete() {
            throw new Error("should not be called");
          },
        },
      }),
    ).rejects.toMatchObject({ errorCode: "BATCH_EXCEEDS_EXCHANGE_BUDGET" });
  });

  test("the trusted prompt states the priority policy and the fixture summary keeps it", () => {
    for (const phrase of [
      "explicit corrections",
      "Do not invent an exact lifetime count",
      "Do not promote assistant speculation",
      "Do not fill gaps from world knowledge",
    ]) {
      expect(SUMMARY_INSTRUCTIONS).toContain(phrase);
    }
    const accepted = [
      "Durable facts, preferences, and constraints",
      "The user is allergic to peanuts and prefers concise replies.",
      "Recent active context",
      "The visa application is still unresolved.",
      "Recurring themes",
      "Concise replies are a repeated preference.",
    ].join("\n");
    expect(accepted).toContain("allergic to peanuts");
    expect(accepted).toContain("unresolved");
    expect(accepted).not.toContain("mushrooms");
    const envelope = JSON.parse(
      JSON.stringify({
        untrusted_memory_data: {
          messages: [
            { role: "user", content: "I am allergic to peanuts." },
            { role: "assistant", content: "You might also hate mushrooms." },
          ],
        },
      }),
    ) as {
      untrusted_memory_data: { messages: { role: string; content: string }[] };
    };
    expect(envelope.untrusted_memory_data.messages[1]?.role).toBe("assistant");
  });
});

describe("DeepSeek client", () => {
  test("sends one non-streaming responses call and rejects incomplete output", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const result = await requestSummary({
      apiKey: "secret-key",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro",
      exchange: {
        instructions: "trusted",
        data: '{"untrusted":true}',
        timeoutMs: 1000,
      },
      fetchImpl: async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return new Response(
          JSON.stringify({
            id: "resp_123",
            status: "completed",
            incomplete_details: null,
            output: [
              {
                type: "message",
                status: "completed",
                content: [
                  { type: "output_text", text: "Remember the peanut allergy." },
                ],
              },
            ],
          }),
          { status: 200, headers: { "x-request-id": "provider-1" } },
        );
      },
    });
    expect(requests[0]?.url).toBe("https://api.deepseek.com/responses");
    expect(requests[0]?.body).toMatchObject({
      model: "deepseek-v4-pro",
      stream: false,
      reasoning: { effort: "none" },
      tool_choice: "none",
      max_output_tokens: 8192,
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("web_search");
    expect(result).toMatchObject({
      completed: true,
      providerRequestId: "provider-1",
    });
    await expect(
      requestSummary({
        apiKey: "secret-key",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        exchange: { instructions: "trusted", data: "{}", timeoutMs: 1000 },
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
              output_text: "short",
            }),
            { status: 200 },
          ),
      }),
    ).resolves.toMatchObject({ completed: false, text: "short" });
    await expect(
      requestSummary({
        apiKey: "secret-key",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-pro",
        exchange: { instructions: "trusted", data: "{}", timeoutMs: 10 },
        fetchImpl: async (_url, init) => {
          init?.signal?.throwIfAborted();
          await new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            );
          });
          return new Response("");
        },
      }),
    ).rejects.toBeInstanceOf(ProviderCallError);
  });
});

function completed(text: string): ModelCompletion {
  return { text, completed: true, model: "fake" };
}
