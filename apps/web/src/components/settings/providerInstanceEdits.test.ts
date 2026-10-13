import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@codework/contracts";
import { makeProviderInstanceEditQueue, rebaseProviderEdit } from "./providerInstanceEdits";

const id = ProviderInstanceId.make("codex_work");
const base: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  config: { homePath: "old-home", binaryPath: "old-binary" },
};
const snapshot = (instance: ProviderInstanceConfig) => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: { [id]: instance },
});
const input = (instance: ProviderInstanceConfig) => ({
  instanceId: id,
  driver: base.driver,
  isDefault: false,
  previous: base,
  instance,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

describe("供应商编辑意图队列", () => {
  it("连续字段基于同一旧快照也保留home、程序和名称，按回执串行", async () => {
    const queue = makeProviderInstanceEditQueue(snapshot(base)),
      gate = deferred<ReturnType<typeof snapshot>>(),
      calls: ProviderInstanceConfig[] = [];
    const save = async (patch: Parameters<Parameters<typeof queue.edit>[1]>[0]) => {
      const instance = patch.providerInstances![id]!;
      calls.push(instance);
      return calls.length === 1 ? gate.promise : snapshot(instance);
    };
    const first = queue.edit(
      input({ ...base, config: { ...(base.config as object), homePath: "isolated-home" } }),
      save,
      (value) => value,
    );
    const second = queue.edit(
      input({ ...base, config: { ...(base.config as object), binaryPath: "fixture.cmd" } }),
      save,
      (value) => value,
    );
    const third = queue.edit(input({ ...base, displayName: "测试实例" }), save, (value) => value);
    expect(calls).toHaveLength(1);
    const firstResult = snapshot(calls[0]!);
    queue.sync(firstResult);
    gate.resolve(firstResult);
    await Promise.all([first, second, third]);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({
      ...base,
      displayName: "测试实例",
      config: { homePath: "isolated-home", binaryPath: "fixture.cmd" },
    });
  });
  it("数组/null/标量和删除键保留替换语义，未改字段不覆盖", () => {
    expect(
      rebaseProviderEdit(
        { config: { a: [1], b: "old", c: 1 } },
        { config: { a: [2], b: null } },
        { config: { a: [1], b: "new", c: 3, d: true } },
      ),
    ).toEqual({ config: { a: [2], b: null, d: true } });
    expect(rebaseProviderEdit({ list: [1] }, { list: [1] }, { list: [1, 2] })).toEqual({
      list: [1, 2],
    });
  });
  it("较早推送不撤销后续回执，其他客户端在等待期间的变化保留", async () => {
    const queue = makeProviderInstanceEditQueue(snapshot(base)),
      gate = deferred<ReturnType<typeof snapshot>>();
    const first = queue.edit(
      input({ ...base, config: { ...(base.config as object), homePath: "new-home" } }),
      () => gate.promise,
      (value) => value,
    );
    queue.sync(snapshot({ ...base, displayName: "远端名称" }));
    gate.resolve(
      snapshot({ ...base, config: { ...(base.config as object), homePath: "new-home" } }),
    );
    await first;
    const result = await queue.edit(
      input({ ...base, config: { ...(base.config as object), binaryPath: "new-binary" } }),
      async (patch) => snapshot(patch.providerInstances![id]!),
      (value) => value,
    );
    expect(result.providerInstances[id]).toEqual({
      ...base,
      displayName: "远端名称",
      config: { homePath: "new-home", binaryPath: "new-binary" },
    });
  });
  it("失败不推进快照、不重试，后续编辑仍可执行", async () => {
    const queue = makeProviderInstanceEditQueue(snapshot(base));
    let calls = 0;
    await expect(
      queue.edit(
        input({ ...base, displayName: "失败名称" }),
        async () => {
          calls++;
          throw Error("offline");
        },
        () => undefined,
      ),
    ).rejects.toThrow("offline");
    const result = await queue.edit(
      input({ ...base, config: { ...(base.config as object), binaryPath: "new" } }),
      async (patch) => {
        calls++;
        return snapshot(patch.providerInstances![id]!);
      },
      (value) => value,
    );
    expect(calls).toBe(2);
    expect(result.providerInstances[id]?.displayName).toBeUndefined();
  });
});
