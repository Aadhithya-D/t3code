// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  KiroSettings,
  ProviderDriverKind,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../../config.ts";
import { makeKiroAdapter } from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockKiroWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-kiro-cli.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    `#!/bin/sh\n${envExports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)} "$@"\n`,
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(filePath: string, attempts = 40): Effect.Effect<string> {
  const attempt = (remaining: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remaining <= 0) return yield* Effect.die(`Timed out waiting for ${filePath}`);
      const content = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (content.trim()) return content;
      yield* Effect.sleep("25 millis");
      return yield* attempt(remaining - 1);
    });
  return attempt(attempts);
}

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(testLayer)("KiroAdapter", (it) => {
  it.effect("starts a session, sends a message, and streams the response", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-message");
      const binaryPath = yield* Effect.promise(() => makeMockKiroWrapper());
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));
      const events: ProviderRuntimeEvent[] = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => events.push(event)),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "hello kiro", attachments: [] });

      assert.equal(session.provider, "kiro");
      assert.include(
        events.map((event) => event.type),
        "content.delta",
      );
      assert.include(
        events.map((event) => event.type),
        "turn.completed",
      );
      assert.equal(
        events.find((event) => event.type === "content.delta")?.payload.delta,
        "hello from mock",
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stops an in-flight message and accepts a follow-up", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-interrupt");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));
      const events: ProviderRuntimeEvent[] = [];
      const firstApproval = yield* Deferred.make<ApprovalRequestId>();
      const secondApproval = yield* Deferred.make<ApprovalRequestId>();
      let approvalCount = 0;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type !== "request.opened") return;
          approvalCount += 1;
          const deferred = approvalCount === 1 ? firstApproval : secondApproval;
          yield* Deferred.succeed(deferred, ApprovalRequestId.make(String(event.requestId))).pipe(
            Effect.ignore,
          );
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "stop this", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstApproval);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(firstTurn);
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "continue", attachments: [] })
        .pipe(Effect.forkChild);
      yield* adapter.respondToRequest(threadId, yield* Deferred.await(secondApproval), "accept");
      yield* Fiber.join(followUp);

      const completed = events.filter((event) => event.type === "turn.completed");
      assert.deepEqual(
        completed.map((event) => event.payload.state),
        ["cancelled", "completed"],
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("cancels an in-flight Kiro turn when a follow-up message arrives", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-follow-up-cancels-live-turn");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }), {
        concurrentPromptRetryDelaysMs: [0, 50],
      });
      const events: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<string>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = { current: 0 };
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, String(event.turnId)).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            completedCountRef.current += 1;
            if (completedCountRef.current === 2) {
              yield* Deferred.succeed(twoTurnsCompleted, undefined).pipe(Effect.ignore);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "work forever", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted);
      const followUp = yield* adapter.sendTurn({
        threadId,
        input: "new instructions",
        attachments: [],
      });
      yield* Fiber.join(firstTurn);
      yield* Deferred.await(twoTurnsCompleted);

      const completed = events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.notEqual(String(followUp.turnId), firstTurnId);
      assert.deepEqual(
        completed.map((event) => [String(event.turnId), event.payload.state]),
        [
          [firstTurnId, "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("accepts a Kiro follow-up after Stop while the previous prompt is still hanging", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-stop-then-follow-up");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }), {
        concurrentPromptRetryDelaysMs: [0, 50],
      });
      const events: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<string>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = { current: 0 };
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, String(event.turnId)).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            completedCountRef.current += 1;
            if (completedCountRef.current === 2) {
              yield* Deferred.succeed(twoTurnsCompleted, undefined).pipe(Effect.ignore);
            }
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstTurn = yield* adapter
        .sendTurn({ threadId, input: "work forever", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted);
      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(firstTurn);
      const followUp = yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });
      yield* Deferred.await(twoTurnsCompleted);

      const completed = events.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      assert.notEqual(String(followUp.turnId), firstTurnId);
      assert.deepEqual(
        completed.map((event) => [String(event.turnId), event.payload.state]),
        [
          [firstTurnId, "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      const session = (yield* adapter.listSessions()).find(
        (candidate) => candidate.threadId === threadId,
      );
      assert.equal(session?.status, "ready");
      assert.isUndefined(session?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("closes the Kiro ACP child when the session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-stop-session");
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-exit-")),
      );
      const exitLogPath = NodePath.join(dir, "exit.log");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EXIT_LOG_PATH: exitLogPath }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      assert.include(yield* waitForFileContent(exitLogPath), "SIGTERM");
    }),
  );

  it.effect("projects a Kiro child session as a subagent and keeps the parent turn alive", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-subagent-liveness");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_CHILD_SESSION_THEN_HANG: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }), {
        turnInactivityTimeoutMs: 400,
        activeToolInactivityTimeoutMs: 8_000,
      });
      const events: ProviderRuntimeEvent[] = [];
      const taskStarted = yield* Deferred.make<void>();
      const turnCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
          if (event.type === "task.started") {
            yield* Deferred.succeed(taskStarted, undefined).pipe(Effect.ignore);
          }
          if (event.type === "turn.completed") {
            yield* Deferred.succeed(turnCompleted, event).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "spawn a subagent", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(taskStarted);

      yield* Effect.sleep("900 millis");
      assert.lengthOf(
        events.filter((event) => event.type === "turn.completed"),
        0,
      );
      const started = events.find((event) => event.type === "task.started");
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.taskType, "subagent");
        assert.equal(String(started.payload.taskId), "mock-child-session-1");
      }
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "item.updated" &&
            event.payload.agentId === "mock-child-session-1" &&
            event.payload.title === "Child-only tool",
        ),
      );

      yield* adapter.interruptTurn(threadId);
      const completed = yield* Deferred.await(turnCompleted);
      yield* Fiber.join(sendTurnFiber);
      assert.equal(completed.payload.state, "cancelled");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("maps Kiro vendor subagent notifications into task lifecycle events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-subagent-lifecycle");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_KIRO_SUBAGENT_LIFECYCLE: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));
      const events: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "spawn a subagent",
        attachments: [],
      });
      yield* Deferred.await(turnCompleted);

      const childTasks = events.filter(
        (event) =>
          (event.type === "task.started" ||
            event.type === "task.progress" ||
            event.type === "task.completed") &&
          event.payload.taskId === "mock-child-session-1",
      );
      const started = events.find((event) => event.type === "task.started");
      assert.equal(started?.type, "task.started");
      if (started?.type === "task.started") {
        assert.equal(started.payload.taskType, "subagent");
        assert.equal(String(started.payload.taskId), "mock-child-session-1");
      }
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "item.updated" &&
            event.payload.agentId === undefined &&
            event.payload.title === "subagent",
        ),
      );
      assert.isTrue(childTasks.some((event) => event.type === "task.progress"));
      assert.isTrue(
        events.some(
          (event) => event.type === "task.progress" && event.payload.title === "Explorer",
        ),
      );
      assert.isTrue(
        childTasks.some(
          (event) => event.type === "task.completed" && event.payload.status === "completed",
        ),
      );
      assert.isTrue(
        events.some(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            event.payload.agentId === "mock-child-session-1" &&
            event.payload.title === "Child-only tool",
        ),
      );
      assert.isFalse(
        events.some(
          (event) =>
            (event.type === "item.updated" || event.type === "item.completed") &&
            event.payload.agentId === undefined &&
            event.payload.title === "Child-only tool",
        ),
      );
      const parentContent = events
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta",
        )
        .map((event) => event.payload.delta)
        .join("");
      assert.include(parentContent, "delegating");
      assert.include(parentContent, "subagent finished");
      assert.notInclude(parentContent, "Child-only tool");

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("counts Kiro _kiro.dev/session/update chunks as watchdog liveness", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-vendor-subagent-liveness");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_KIRO_SUBAGENT_THEN_HANG: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }), {
        turnInactivityTimeoutMs: 400,
        activeToolInactivityTimeoutMs: 8_000,
      });
      const events: ProviderRuntimeEvent[] = [];
      const taskStarted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
          if (event.type === "task.started") {
            yield* Deferred.succeed(taskStarted, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "spawn a subagent", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(taskStarted);
      yield* Effect.sleep("900 millis");
      assert.lengthOf(
        events.filter((event) => event.type === "turn.completed"),
        0,
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "task.started" && event.payload.taskId === "mock-child-session-1",
        ),
      );

      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not treat parent-session Kiro tool chunks as subagents", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-parent-tool-chunk");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_KIRO_PARENT_TOOL_CHUNK: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }));
      const events: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed" && String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnCompleted, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "find the files",
        attachments: [],
      });
      yield* Deferred.await(turnCompleted);

      assert.isFalse(events.some((event) => event.type === "task.started"));
      assert.isFalse(events.some((event) => event.type === "task.completed"));
      assert.isTrue(
        events.some(
          (event) => event.type === "item.updated" && event.payload.title === "glob",
        ),
      );
      const completed = events.find((event) => event.type === "turn.completed");
      assert.equal(completed?.type, "turn.completed");
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("keeps a Kiro turn alive from child-session metadata without a subagent row", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-child-metadata-liveness");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_KIRO_CHILD_METADATA_THEN_HANG: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }), {
        turnInactivityTimeoutMs: 400,
        activeToolInactivityTimeoutMs: 8_000,
      });
      const events: ProviderRuntimeEvent[] = [];
      const usageSeen = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
          if (event.type === "thread.token-usage.updated") {
            yield* Deferred.succeed(usageSeen, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "spawn a crew", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(usageSeen);
      yield* Effect.sleep("900 millis");
      assert.lengthOf(
        events.filter((event) => event.type === "turn.completed"),
        0,
      );
      assert.isFalse(events.some((event) => event.type === "task.started"));

      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("counts parent-session Kiro tool chunks as watchdog liveness only", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("kiro-parent-tool-chunk-liveness");
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({ T3_ACP_EMIT_KIRO_PARENT_TOOL_CHUNK_THEN_HANG: "1" }),
      );
      const adapter = yield* makeKiroAdapter(decodeKiroSettings({ binaryPath }), {
        turnInactivityTimeoutMs: 400,
        activeToolInactivityTimeoutMs: 8_000,
      });
      const events: ProviderRuntimeEvent[] = [];
      const toolSeen = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          events.push(event);
          if (event.type === "item.updated" && event.payload.title === "glob") {
            yield* Deferred.succeed(toolSeen, undefined).pipe(Effect.ignore);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "keep searching", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(toolSeen);
      yield* Effect.sleep("900 millis");
      assert.lengthOf(
        events.filter((event) => event.type === "turn.completed"),
        0,
      );
      assert.isFalse(events.some((event) => event.type === "task.started"));

      yield* adapter.interruptTurn(threadId);
      yield* Fiber.join(sendTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );
});
