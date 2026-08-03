import { describe, expect, it } from "@effect/vitest";

import {
  isPromptAlreadyInProgressMessage,
  threadTokenUsageFromKiroMetadata,
} from "./KiroAcpExtension.ts";

describe("KiroAcpExtension", () => {
  it("maps context percentage and credits into a token-usage snapshot", () => {
    const usage = threadTokenUsageFromKiroMetadata({
      sessionId: "session-1",
      contextUsagePercentage: 1.7333,
      meteringUsage: [{ value: 0.121, unit: "credit", unitPlural: "credits" }],
      turnDurationMs: 3706,
      effort: "medium",
    });

    expect(usage).toMatchObject({
      maxTokens: 100_000,
      creditsUsed: 0.121,
      creditsUnit: "credits",
      durationMs: 3706,
    });
    expect(usage?.usedTokens).toBeGreaterThan(0);
    expect(usage?.usedTokens).toBeLessThanOrEqual(100_000);
  });

  it("returns undefined when metadata has nothing to display", () => {
    expect(
      threadTokenUsageFromKiroMetadata({
        sessionId: "session-1",
        effort: "medium",
      }),
    ).toBeUndefined();
  });

  it("detects concurrent-prompt errors from Kiro", () => {
    expect(isPromptAlreadyInProgressMessage("Internal error: Prompt already in progress")).toBe(
      true,
    );
    expect(isPromptAlreadyInProgressMessage("Internal error")).toBe(false);
  });
});
