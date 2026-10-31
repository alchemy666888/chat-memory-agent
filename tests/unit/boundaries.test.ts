import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesUnder(path);
    return [path];
  });
}

describe("no automatic processing", () => {
  test("runtime source has no scheduler and only the process route calls the model", () => {
    const files = filesUnder("src").filter(
      (path) => path.endsWith(".ts") || path.endsWith(".tsx"),
    );
    const combined = files.map((path) => readFileSync(path, "utf8")).join("\n");
    expect(combined).not.toMatch(
      /node-cron|setInterval\(|vercel\.json|instrumentation/,
    );
    const modelCallers = files.filter((path) =>
      readFileSync(path, "utf8").includes("requestSummary({"),
    );
    expect(modelCallers).toEqual(["src/app/api/v1/memory/process/route.ts"]);
    expect(
      readFileSync("src/app/api/v1/messages/route.ts", "utf8"),
    ).not.toContain("deepseek");
    expect(readFileSync("src/app/api/health/route.ts", "utf8")).not.toContain(
      "deepseek",
    );
  });
});
