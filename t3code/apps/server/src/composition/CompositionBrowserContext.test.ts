import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { makeCompositionBrowserScope } from "./CompositionBrowserContext.ts";

it("为同一个 Composition Run 生成稳定且独立于 Provider session 的浏览器上下文", () => {
  const first = makeCompositionBrowserScope({
    environmentId: EnvironmentId.make("environment-1"),
    taskId: "task-browser-1",
    runId: "run-browser-1",
    runtimeId: "multica:daemon-1",
    threadId: "thread-browser-1",
    issuedAt: 100,
  });
  const second = makeCompositionBrowserScope({
    environmentId: EnvironmentId.make("environment-1"),
    taskId: "task-browser-1",
    runId: "run-browser-1",
    runtimeId: "multica:daemon-1",
    threadId: "thread-browser-1",
    issuedAt: 200,
  });

  expect(first.sessionId).toBe("composition-browser:task-browser-1:run-browser-1");
  expect(first.sessionId).toBe(second.sessionId);
  expect(first.providerSessionId).toBeUndefined();
  expect(first.environmentId).toBe(EnvironmentId.make("environment-1"));
  expect(first.threadId).toBe(ThreadId.make("thread-browser-1"));
  expect(first.providerInstanceId).toBe(ProviderInstanceId.make("composition-multica-daemon-1"));
  expect(first.capabilities).toEqual(new Set(["preview"]));
  expect(first.issuedAt).toBe(100);
});

it("没有显式 threadId 时使用稳定的 Composition task thread", () => {
  const scope = makeCompositionBrowserScope({
    environmentId: EnvironmentId.make("environment-1"),
    taskId: "task-browser-2",
    runId: "run-browser-2",
    runtimeId: "runtime-2",
    issuedAt: 300,
  });

  expect(scope.threadId).toBe(ThreadId.make("composition-task-browser-2"));
});
