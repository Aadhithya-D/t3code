import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildKiroAcpSpawnInput,
  normalizeKiroEffort,
  resolveKiroAcpModelId,
  resolveKiroEffortFromModelSelection,
  steerKiroAcpTurn,
} from "./KiroAcpSupport.ts";

describe("buildKiroAcpSpawnInput", () => {
  it("spawns Kiro's documented ACP command", () => {
    expect(
      buildKiroAcpSpawnInput({ binaryPath: "/usr/local/bin/kiro-cli" }, "/tmp/project", {
        KIRO_API_KEY: "secret",
      }),
    ).toEqual({
      command: "/usr/local/bin/kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { KIRO_API_KEY: "secret" },
    });
  });

  it("passes --effort when an initial effort is provided", () => {
    expect(
      buildKiroAcpSpawnInput({ binaryPath: "kiro-cli" }, "/tmp/project", undefined, "high"),
    ).toEqual({
      command: "kiro-cli",
      args: ["acp", "--effort", "high"],
      cwd: "/tmp/project",
    });
  });

  it("ignores unrecognized effort values on spawn", () => {
    expect(
      buildKiroAcpSpawnInput({ binaryPath: "kiro-cli" }, "/tmp/project", undefined, "turbo"),
    ).toEqual({
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

it.effect("wraps in-flight Kiro steering in the documented ACP extension", () =>
  Effect.gen(function* () {
    let observed: { method: string; payload: unknown } | undefined;
    yield* steerKiroAcpTurn({
      runtime: {
        request: (method, payload) =>
          Effect.sync(() => {
            observed = { method, payload };
            return { queued: true };
          }),
      },
      sessionId: "session-1",
      text: " focus on cancellation ",
    });

    assert.deepEqual(observed, {
      method: "_session/steer",
      payload: {
        sessionId: "session-1",
        message: "<user_message>\nfocus on cancellation\n</user_message>",
      },
    });
  }),
);

it.effect("rejects steering that Kiro did not acknowledge as queued", () =>
  Effect.gen(function* () {
    for (const response of [{ queued: false }, {}, null]) {
      const result = yield* steerKiroAcpTurn({
        runtime: { request: () => Effect.succeed(response) },
        sessionId: "session-1",
        text: "continue",
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
    }
  }),
);

describe("resolveKiroAcpModelId", () => {
  it("keeps the selectable default slug and normalizes explicit model ids", () => {
    expect(resolveKiroAcpModelId(undefined)).toBeUndefined();
    expect(resolveKiroAcpModelId("")).toBeUndefined();
    expect(resolveKiroAcpModelId(" default ")).toBe("default");
    expect(resolveKiroAcpModelId(" claude-opus-4.6 ")).toBe("claude-opus-4.6");
  });
});

describe("normalizeKiroEffort", () => {
  it("normalizes supported effort aliases", () => {
    expect(normalizeKiroEffort(" LOW ")).toBe("low");
    expect(normalizeKiroEffort("medium")).toBe("medium");
    expect(normalizeKiroEffort("xhigh")).toBe("xhigh");
    expect(normalizeKiroEffort("extra-high")).toBe("xhigh");
    expect(normalizeKiroEffort("max")).toBe("max");
    expect(normalizeKiroEffort("nope")).toBeUndefined();
  });
});

describe("resolveKiroEffortFromModelSelection", () => {
  it("reads the effort option from model selection", () => {
    expect(
      resolveKiroEffortFromModelSelection({
        model: "claude-opus-4.8",
        options: [{ id: "effort", value: "high" }],
      }),
    ).toBe("high");
    expect(
      resolveKiroEffortFromModelSelection({
        model: "auto",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe("xhigh");
    expect(resolveKiroEffortFromModelSelection({ model: "auto", options: [] })).toBeUndefined();
  });
});
