import { describe, expect, it } from "@effect/vitest";

import {
  isAcpSubagentSpawnTool,
  isBareJsonRpcInternalErrorMessage,
  isConcurrentPromptRejection,
  isKiroSubagentTerminalStatus,
  isKiroVendorExtensionMethod,
  isPromptAlreadyInProgressMessage,
  isRetryableBusySessionPromptError,
  kiroSubagentEntriesFromListUpdate,
  kiroSubagentEntryId,
  kiroSubagentIdFromToolCall,
  kiroVendorChildSessionId,
  kiroVendorSessionUpdateKind,
  kiroVendorSessionUpdateTitle,
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
    expect(isBareJsonRpcInternalErrorMessage("Internal error")).toBe(true);
    expect(
      isBareJsonRpcInternalErrorMessage(
        "Provider adapter request failed (kiro) for session/prompt: Internal error",
      ),
    ).toBe(true);
    expect(isBareJsonRpcInternalErrorMessage("Internal error: Prompt already in progress")).toBe(
      false,
    );

    expect(
      isConcurrentPromptRejection({
        message: "Internal error",
        data: "Prompt already in progress",
      }),
    ).toBe(true);
    expect(isConcurrentPromptRejection({ message: "Internal error" })).toBe(false);

    expect(
      isRetryableBusySessionPromptError({
        message: "Provider adapter request failed (kiro) for session/prompt: Internal error",
        cause: { message: "Internal error", data: "Prompt already in progress" },
      }),
    ).toBe(true);
    expect(
      isRetryableBusySessionPromptError(
        {
          message: "Provider adapter request failed (kiro) for session/prompt: Internal error",
        },
        { recentlyCancelled: true },
      ),
    ).toBe(true);
    expect(
      isRetryableBusySessionPromptError(
        {
          message: "Provider adapter request failed (kiro) for session/prompt: Internal error",
        },
        { recentlyCancelled: false },
      ),
    ).toBe(false);
  });

  it("recognizes Kiro subagent spawn tools", () => {
    expect(
      isAcpSubagentSpawnTool({
        title: "subagent",
        data: { rawInput: { sessionId: "child-1", prompt: "look around" } },
      }),
    ).toBe(true);
    expect(
      isAcpSubagentSpawnTool({
        title: "Write",
        data: { rawInput: { path: "README.md" } },
      }),
    ).toBe(false);
    expect(
      kiroSubagentIdFromToolCall({
        toolCallId: "tool-1",
        data: { rawInput: { sessionId: "child-1" } },
      }),
    ).toBe("child-1");
  });

  it("reads child ids from Kiro vendor session updates", () => {
    expect(
      kiroVendorChildSessionId(
        {
          sessionId: "child-2",
          sessionUpdate: "tool_call_chunk",
          toolCallId: "tool-2",
          title: "Read file",
        },
        "parent-session",
      ),
    ).toBe("child-2");
    expect(
      kiroVendorChildSessionId(
        {
          sessionId: "parent-session",
          sessionUpdate: "tool_call_chunk",
          toolCallId: "tool-2",
          title: "glob",
        },
        "parent-session",
      ),
    ).toBeUndefined();
    expect(kiroVendorSessionUpdateKind({ sessionUpdate: "tool_call_chunk" })).toBe(
      "tool_call_chunk",
    );
    expect(
      kiroVendorSessionUpdateTitle({
        update: { sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } },
      }),
    ).toBe("thinking");
    expect(isKiroVendorExtensionMethod("_kiro.dev/session/update")).toBe(true);
    expect(isKiroVendorExtensionMethod("session/update")).toBe(false);
  });

  it("reads Kiro subagent roster updates", () => {
    const entries = kiroSubagentEntriesFromListUpdate({
      sessionId: "parent-1",
      agents: [
        { sessionId: "child-1", status: "running", title: "Explorer" },
        { sessionId: "child-2", status: "completed" },
      ],
    });
    expect(entries.map((entry) => kiroSubagentEntryId(entry))).toEqual(["child-1", "child-2"]);
    expect(isKiroSubagentTerminalStatus("running")).toBe(false);
    expect(isKiroSubagentTerminalStatus("completed")).toBe(true);
    expect(isKiroSubagentTerminalStatus("terminated")).toBe(true);
  });
});
