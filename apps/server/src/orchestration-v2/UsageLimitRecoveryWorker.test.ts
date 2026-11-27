import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import {
  accountSwitchCommand,
  limitRecoveryCommand,
  markLimitedAccount,
} from "./UsageLimitRecoveryWorker.ts";

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });
});

describe("account switching", () => {
  const model = "gemini-3.1-pro";
  const settings = {
    ...DEFAULT_SERVER_SETTINGS,
    autoSwitchLimitedAccounts: true,
    providerInstances: Object.fromEntries(
      ["antigravity", "antigravity_2", "antigravity_3"].map((id) => [
        id,
        { driver: ProviderDriverKind.make("antigravity"), enabled: true, config: {} },
      ]),
    ),
  };
  const account = (id: string): ServerProvider => ({
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-19T11:00:00.000Z",
    models: [{ slug: model, name: "Gemini 3.1 Pro", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });
  const providers = [account("antigravity"), account("antigravity_2"), account("antigravity_3")];
  const limited = (
    instanceId: string,
    runId = "run:limited",
  ): ProjectionStore.ProjectionAccountSwitchCandidate => ({
    id: ThreadId.make("thread:limited"),
    projectId: ProjectId.make("project:a"),
    latestRunId: RunId.make(runId),
    modelSelection: { instanceId: ProviderInstanceId.make(instanceId), model },
    usageLimitResetAt: null,
  });

  const failOn =
    (state: Parameters<typeof accountSwitchCommand>[1]) =>
    (candidate: ProjectionStore.ProjectionAccountSwitchCandidate, at = state.nowMs) => {
      markLimitedAccount(state.limited, candidate, at);
      return accountSwitchCommand(candidate, { ...state, nowMs: at });
    };

  it("continues on the next account and does not bounce back to a limited one", () => {
    const fail = failOn({ providers, settings, nowMs, limited: new Map() });
    const first = fail(limited("antigravity"));
    assert.equal(first?.modelSelection?.instanceId, "antigravity_2");
    assert.equal(first?.text, "Continue where you left off.");
    assert.equal(first?.createdBy, "agent");
    const second = fail(limited("antigravity_2", "run:second"));
    assert.equal(second?.modelSelection?.instanceId, "antigravity_3");
    assert.isNull(fail(limited("antigravity_3", "run:third")));
    // An hour later the first account is tried again.
    const later = fail(limited("antigravity_3", "run:fourth"), nowMs + HOUR_MS + 1);
    assert.equal(later?.modelSelection?.instanceId, "antigravity");
  });

  it("keeps a limited account out until its reported reset", () => {
    const fail = failOn({ providers, settings, nowMs, limited: new Map() });
    fail({
      ...limited("antigravity_2"),
      usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 3 * HOUR_MS)),
    });
    const next = fail(limited("antigravity_3", "run:second"), nowMs + 2 * HOUR_MS);
    assert.equal(next?.modelSelection?.instanceId, "antigravity");
  });

  it.effect("switches before arming auto-resume, once per failed run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const dispatched: Array<
        Parameters<ThreadManagement.ThreadManagementService["Service"]["dispatch"]>[0]
      > = [];
      const armed: Array<unknown> = [];
      let recoveryReads = 0;
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getAccountSwitchCandidates: () => Effect.succeed([limited("antigravity")]),
              // The same sweep still sees the failed run; later ones see the switched run.
              getLimitRecoveryCandidates: () =>
                Effect.sync(() =>
                  recoveryReads++ > 0
                    ? []
                    : [{ ...failedThread(0, -HOUR_MS), id: limited("x").id }],
                ),
              getLimitRecoveryWakeAt: () => Effect.succeed(null),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(command);
                }) as never,
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(providers),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.never,
              autoArmLimitRecovery: (input) =>
                Effect.sync(() => {
                  armed.push(input);
                }) as never,
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({ ...settings, autoResumeLimitedThreads: true }),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        yield* TestClock.adjust("10 seconds");
        yield* TestClock.adjust("10 seconds");
      }).pipe(Effect.provide(layer));
      assert.equal(dispatched.length, 1);
      const [command] = dispatched;
      assert.equal(command?.type, "message.dispatch");
      if (command?.type === "message.dispatch") {
        assert.equal(command.modelSelection?.instanceId, "antigravity_2");
      }
      assert.deepEqual(armed, []);
    }),
  );

  it.effect("retries a waiting thread without extending its account's limit", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const dispatched: Array<string | undefined> = [];
      const waiting = (instanceId: string, threadId: string) => ({
        ...limited(instanceId, `run:${threadId}`),
        id: ThreadId.make(threadId),
      });
      const layer = UsageLimitRecoveryWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              // Both accounts are limited, so each thread waits on the other's account.
              getAccountSwitchCandidates: () =>
                Effect.succeed([
                  waiting("antigravity", "thread:a"),
                  waiting("antigravity_2", "thread:b"),
                ]),
              getLimitRecoveryCandidates: () => Effect.succeed([]),
              getLimitRecoveryWakeAt: () => Effect.succeed(null),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatched.push(
                    command.type === "message.dispatch"
                      ? command.modelSelection?.instanceId
                      : command.type,
                  );
                }) as never,
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(providers.slice(0, 2)),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({
              streamDomainEvents: Stream.fromQueue(events),
            }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed(settings),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 second");
        assert.deepEqual(dispatched, []);
        yield* TestClock.adjust(HOUR_MS);
        yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
        yield* TestClock.adjust("10 seconds");
      }).pipe(Effect.provide(layer));
      assert.deepEqual(dispatched.toSorted(), ["antigravity", "antigravity_2"]);
    }),
  );
});
