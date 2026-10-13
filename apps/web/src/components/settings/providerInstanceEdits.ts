import type { ProviderInstanceConfig, ServerSettings } from "@codework/contracts";
import { stableStringify } from "@codework/shared/relaySigning";
import { buildProviderInstanceUpdatePatch } from "./SettingsPanels.logic";

type Snapshot = Pick<ServerSettings, "providers" | "providerInstances">;
type Edit = Omit<Parameters<typeof buildProviderInstanceUpdatePatch>[0], "settings"> & {
  readonly previous: ProviderInstanceConfig;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** 只重放用户改变的字段；删除键、数组、标量与null仍是替换操作。 */
export function rebaseProviderEdit(previous: unknown, next: unknown, current: unknown): unknown {
  if (Object.is(previous, next) || stableStringify(previous) === stableStringify(next))
    return current;
  if (!isRecord(previous) || !isRecord(next) || !isRecord(current)) return next;
  const result = { ...current };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
    if (!Object.hasOwn(next, key)) {
      delete result[key];
    } else if (!Object.hasOwn(previous, key)) {
      result[key] = next[key];
    } else {
      result[key] = rebaseProviderEdit(previous[key], next[key], current[key]);
    }
  }
  return result;
}

/** 每个环境单独持有队列，成功回执是下一次保存的基础；失败不推进快照。 */
export function makeProviderInstanceEditQueue(initial: Snapshot) {
  const scope = (snapshot: Snapshot): Snapshot => ({
    providers: snapshot.providers,
    providerInstances: snapshot.providerInstances,
  });
  let observed = scope(initial);
  let current = observed;
  let tail: Promise<void> | null = null;
  return {
    sync(snapshot: Snapshot) {
      if (
        observed.providers === snapshot.providers &&
        observed.providerInstances === snapshot.providerInstances
      )
        return;
      // 收到较早保存的推送时，只应用它相对上一推送的变化，保留后续成功回执。
      const next = scope(snapshot);
      current = rebaseProviderEdit(observed, next, current) as Snapshot;
      observed = next;
    },
    edit<R>(
      input: Edit,
      save: (patch: ReturnType<typeof buildProviderInstanceUpdatePatch>) => Promise<R>,
      committed: (result: R) => Snapshot | undefined,
    ): Promise<R> {
      const run = async () => {
        const beforeSave = current;
        const beforePush = observed;
        const instance = rebaseProviderEdit(
          input.previous,
          input.instance,
          current.providerInstances[input.instanceId] ?? input.previous,
        ) as ProviderInstanceConfig;
        const result = await save(
          buildProviderInstanceUpdatePatch({ ...input, instance, settings: current }),
        );
        const snapshot = committed(result);
        if (snapshot) {
          const withReceipt = rebaseProviderEdit(beforeSave, scope(snapshot), current);
          current = rebaseProviderEdit(beforePush, observed, withReceipt) as Snapshot;
        }
        return result;
      };
      const pending = tail ? tail.then(run) : run();
      const settled = pending.then(
        () => undefined,
        () => undefined,
      );
      tail = settled;
      void settled.then(() => {
        if (tail === settled) tail = null;
      });
      return pending;
    },
  };
}
