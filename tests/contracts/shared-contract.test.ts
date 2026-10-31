import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  codePointLength,
  parseIngestBody,
  parseProcessBody,
} from "../../src/server/chat-memory/contracts";

const contract = readFileSync("docs/chat-memory-contract-v1.md", "utf8");

describe("shared contract v1 fixtures", () => {
  test("the documented ingestion example parses and the process body stays empty", () => {
    const example = {
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
    expect(parseIngestBody(example).content).toBe(example.content);
    expect(parseProcessBody({})).toEqual({});
    expect(contract).toContain("POST /api/v1/messages");
    expect(contract).toContain("POST /api/v1/memory/process");
    expect(contract).toContain("get_chat_memory");
    expect(contract).toContain("8,000");
  });

  test("the memory-read example counts are computed from its content", () => {
    const pending = [
      {
        raw_message_id: "91",
        event_key: "tg:987654320:user",
        turn_id: "tg:987654320",
        source_update_id: "987654320",
        role: "user",
        content: "Use a friendly tone.",
        occurred_at: "2026-10-28T10:04:00.000Z",
        content_truncated: false,
      },
    ];
    const returnedCharacters = pending.reduce(
      (total, message) => total + codePointLength(message.content),
      0,
    );
    const window = {
      returned_messages: pending.length,
      returned_characters: returnedCharacters,
      has_more_pending: false,
    };
    expect(window).toEqual({
      returned_messages: 1,
      returned_characters: 20,
      has_more_pending: false,
    });
    expect(
      codePointLength("The user prefers concise replies."),
    ).toBeGreaterThan(0);
    const documented = contract.slice(
      contract.indexOf("Successful tool structuredContent"),
      contract.indexOf("Unknown chat"),
    );
    expect(documented).toContain(
      `"returned_characters": ${returnedCharacters}`,
    );
    expect(documented).toContain('"content": "Use a friendly tone."');
  });
});
