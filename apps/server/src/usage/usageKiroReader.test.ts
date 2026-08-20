// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  parseKiroSessionDocument,
  parseKiroTurn,
  readKiroUsage,
  resolveKiroSessionsDir,
  USD_PER_KIRO_CREDIT,
} from "./usageKiroReader.ts";

function turn(overrides: Record<string, unknown> = {}) {
  return {
    end_timestamp: "2026-08-08T12:00:00.000Z",
    input_token_count: 0,
    output_token_count: 0,
    metering_usage: [{ value: 2.5, unit: "credit", unitPlural: "credits" }],
    ...overrides,
  };
}

function sessionDocument(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "sess-1",
    session_state: {
      conversation_metadata: {
        user_turn_metadatas: [turn()],
      },
      rts_model_state: {
        model_info: {
          model_id: "claude-opus-4.8",
          model_name: "Claude Opus 4.8",
        },
      },
    },
    ...overrides,
  };
}

describe("parseKiroTurn", () => {
  it("converts credits at the public overage rate and keeps zero tokens honest", () => {
    const record = parseKiroTurn(turn(), "sess-1", "claude-opus-4.8");

    expect(record).toEqual({
      provider: "kiro",
      timestampMs: Date.parse("2026-08-08T12:00:00.000Z"),
      model: "claude-opus-4.8",
      sessionId: "sess-1",
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      reportedCostUsd: 2.5 * USD_PER_KIRO_CREDIT,
      dedupeKey: "kiro:sess-1:2026-08-08T12:00:00.000Z",
    });
  });

  it("prefers a turn-level model id when present", () => {
    const record = parseKiroTurn(
      turn({
        result: {
          Ok: {
            content: [{ kind: "toolUse", data: { modelId: "auto" } }],
          },
        },
      }),
      "sess-1",
      "claude-opus-4.8",
    );

    expect(record?.model).toBe("auto");
  });

  it("ignores turns without credits, tokens, model, or timestamp", () => {
    expect(parseKiroTurn(turn({ metering_usage: [] }), "sess-1", "claude-opus-4.8")).toBeNull();
    expect(parseKiroTurn(turn({ end_timestamp: null }), "sess-1", "claude-opus-4.8")).toBeNull();
    expect(parseKiroTurn(turn(), "sess-1", "")).toBeNull();
    expect(
      parseKiroTurn(
        turn({
          metering_usage: [],
          input_token_count: 12,
          output_token_count: 4,
        }),
        "sess-1",
        "claude-opus-4.8",
      )?.totals,
    ).toEqual({
      uncachedInputTokens: 12,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 4,
      reasoningTokens: 0,
    });
  });
});

describe("parseKiroSessionDocument", () => {
  it("reads metering turns from the session sidecar shape", () => {
    const records = parseKiroSessionDocument(sessionDocument());

    expect(records).toHaveLength(1);
    expect(records[0]?.provider).toBe("kiro");
    expect(records[0]?.reportedCostUsd).toBeCloseTo(0.1, 8);
  });

  it("returns nothing for empty or malformed sidecars", () => {
    expect(parseKiroSessionDocument(null)).toEqual([]);
    expect(parseKiroSessionDocument({ session_id: "sess-1" })).toEqual([]);
    expect(
      parseKiroSessionDocument({
        session_id: "sess-1",
        session_state: { conversation_metadata: { user_turn_metadatas: [] } },
      }),
    ).toEqual([]);
  });
});

describe("resolveKiroSessionsDir", () => {
  it("uses the documented ~/.kiro/sessions/cli layout", () => {
    expect(resolveKiroSessionsDir("/home/dev")).toBe(
      NodePath.join("/home/dev", ".kiro", "sessions", "cli"),
    );
  });
});

describe("readKiroUsage", () => {
  it("reads recent sidecars and skips older ones", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-kiro-usage-"));
    const oldPath = NodePath.join(root, "old.json");
    const newPath = NodePath.join(root, "new.json");
    NodeFS.writeFileSync(
      oldPath,
      JSON.stringify(
        sessionDocument({
          session_id: "sess-old",
          session_state: {
            conversation_metadata: {
              user_turn_metadatas: [turn({ end_timestamp: "2026-07-01T00:00:00.000Z" })],
            },
            rts_model_state: {
              model_info: { model_id: "claude-opus-4.8" },
            },
          },
        }),
      ),
    );
    NodeFS.writeFileSync(
      newPath,
      JSON.stringify(
        sessionDocument({
          session_id: "sess-new",
          session_state: {
            conversation_metadata: {
              user_turn_metadatas: [turn({ end_timestamp: "2026-08-08T15:00:00.000Z" })],
            },
            rts_model_state: {
              model_info: { model_id: "claude-opus-4.8" },
            },
          },
        }),
      ),
    );
    const oldTime = new Date("2026-07-01T00:00:00.000Z");
    const newTime = new Date("2026-08-08T15:00:00.000Z");
    NodeFS.utimesSync(oldPath, oldTime, oldTime);
    NodeFS.utimesSync(newPath, newTime, newTime);

    try {
      const result = await readKiroUsage(root, Date.parse("2026-08-01T00:00:00.000Z"));
      expect(result?.scannedFiles).toBe(1);
      expect(result?.records.map((record) => record.sessionId)).toEqual(["sess-new"]);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
