import { describe, expect, test } from "vitest";
import {
  codePointLength,
  SUMMARY_MAX_CODE_POINTS,
} from "../../src/server/chat-memory/contracts";
import { requestSummary } from "../../src/server/deepseek/client";
import {
  SUMMARY_INSTRUCTIONS,
  untrustedDataEnvelope,
} from "../../src/server/deepseek/prompt";

describe("live DeepSeek smoke", () => {
  test("summarizes a non-sensitive fixture without tools", async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey)
      throw new Error("DEEPSEEK_API_KEY is required for the live smoke test");
    const result = await requestSummary({
      apiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      model: process.env.DEEPSEEK_SUMMARY_MODEL ?? "deepseek-v4-pro",
      exchange: {
        instructions: SUMMARY_INSTRUCTIONS,
        data: untrustedDataEnvelope({
          previous_summary: "",
          messages: [
            {
              raw_message_id: "1",
              role: "user",
              occurred_at: "2026-10-28T10:00:00.000Z",
              event_key: "tg:1:user",
              turn_id: "tg:1",
              part: 1,
              parts: 1,
              content: "Please remember that I prefer concise replies.",
            },
          ],
        }),
        timeoutMs: 90_000,
      },
    });
    expect(result.completed).toBe(true);
    expect(codePointLength(result.text.trim())).toBeLessThanOrEqual(
      SUMMARY_MAX_CODE_POINTS,
    );
    expect(result.text.toLowerCase()).toContain("concise");
  });
});
