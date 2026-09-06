// @effect-diagnostics nodeBuiltinImport:off - 仅使用 Node 的随机字节生成外部访问 key。
// @effect-diagnostics globalDate:off - key 的创建时间需要稳定的 ISO 字符串。
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { ServerSecretStore, type SecretStoreError } from "../auth/ServerSecretStore.ts";

/**
 * 外部 Agent key ring。明文只存放在 ServerSecretStore，RPC 只返回摘要；
 * key ring 独立于 BYOK 网关 token，便于撤销且不能借此访问普通 BYOK 路由。
 */
export const LOCAL_GATEWAY_KEYS_SECRET = "local-gateway-keys";

export interface LocalGatewayKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly key: string;
}

export interface LocalGatewayKeySummary {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const decode = (bytes: Uint8Array): LocalGatewayKeyRecord[] => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    const value = asRecord(entry);
    const id = typeof value?.id === "string" ? value.id : "";
    const name = typeof value?.name === "string" ? value.name : "";
    const createdAt = typeof value?.createdAt === "string" ? value.createdAt : "";
    const key = typeof value?.key === "string" ? value.key : "";
    return id && name && createdAt && key ? [{ id, name, createdAt, key }] : [];
  });
};

const encode = (records: readonly LocalGatewayKeyRecord[]): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(records));

const readLocalGatewayKeysUnlocked = (
  secretStore: ServerSecretStore["Service"],
): Effect.Effect<readonly LocalGatewayKeyRecord[], never> =>
  secretStore.get(LOCAL_GATEWAY_KEYS_SECRET).pipe(
    Effect.map((value) => {
      if (Option.isNone(value)) return [];
      try {
        return decode(value.value);
      } catch {
        // 损坏的 key ring 必须失效关闭，不能因为管理数据异常放行请求。
        return [];
      }
    }),
    Effect.catch(() => Effect.succeed([])),
  );

export const readLocalGatewayKeys = (
  secretStore: ServerSecretStore["Service"],
): Effect.Effect<readonly LocalGatewayKeyRecord[], never> =>
  readLocalGatewayKeysUnlocked(secretStore);

export const summarizeLocalGatewayKeys = (
  records: readonly LocalGatewayKeyRecord[],
): readonly LocalGatewayKeySummary[] =>
  records.map(({ id, name, createdAt }) => ({ id, name, createdAt }));

const createKeyValue = (): string => `cwk_${NodeCrypto.randomBytes(32).toString("base64url")}`;
const createId = (): string => `key_${NodeCrypto.randomBytes(9).toString("hex")}`;

// key ring 是读改写操作，串行化管理请求，避免并发覆盖。
// ponytail: 进程内全局锁；多进程部署时需改为存储层事务。
const keyRingLock = Semaphore.makeUnsafe(1);

const withKeyRingLock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  keyRingLock.withPermit(effect);

export const createLocalGatewayKey = (
  secretStore: ServerSecretStore["Service"],
  name: string,
): Effect.Effect<
  { readonly record: LocalGatewayKeyRecord; readonly records: readonly LocalGatewayKeyRecord[] },
  SecretStoreError
> =>
  withKeyRingLock(
    readLocalGatewayKeysUnlocked(secretStore).pipe(
      Effect.flatMap((records) => {
        const record: LocalGatewayKeyRecord = {
          id: createId(),
          name: name.trim(),
          createdAt: new Date().toISOString(),
          key: createKeyValue(),
        };
        const next = [...records, record];
        return secretStore
          .set(LOCAL_GATEWAY_KEYS_SECRET, encode(next))
          .pipe(Effect.as({ record, records: next }));
      }),
    ),
  );

export const rotateLocalGatewayKey = (
  secretStore: ServerSecretStore["Service"],
  id: string,
): Effect.Effect<
  | { readonly record: LocalGatewayKeyRecord; readonly records: readonly LocalGatewayKeyRecord[] }
  | undefined,
  SecretStoreError
> =>
  withKeyRingLock(
    readLocalGatewayKeysUnlocked(secretStore).pipe(
      Effect.flatMap((records) => {
        const index = records.findIndex((record) => record.id === id);
        const previous = index < 0 ? undefined : records[index];
        if (previous === undefined) return Effect.succeed(undefined);
        const record = {
          ...previous,
          key: createKeyValue(),
          createdAt: new Date().toISOString(),
        };
        const next = records.map((entry, current) => (current === index ? record : entry));
        return secretStore
          .set(LOCAL_GATEWAY_KEYS_SECRET, encode(next))
          .pipe(Effect.as({ record, records: next }));
      }),
    ),
  );

export const revokeLocalGatewayKey = (
  secretStore: ServerSecretStore["Service"],
  id: string,
): Effect.Effect<boolean, SecretStoreError> =>
  withKeyRingLock(
    readLocalGatewayKeysUnlocked(secretStore).pipe(
      Effect.flatMap((records) => {
        const next = records.filter((record) => record.id !== id);
        if (next.length === records.length) return Effect.succeed(false);
        return (
          next.length === 0
            ? secretStore.remove(LOCAL_GATEWAY_KEYS_SECRET)
            : secretStore.set(LOCAL_GATEWAY_KEYS_SECRET, encode(next))
        ).pipe(Effect.as(true));
      }),
    ),
  );

const tokenEqual = (provided: string, expected: string): boolean => {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && NodeCrypto.timingSafeEqual(left, right);
};

export const matchLocalGatewayKey = (
  records: readonly LocalGatewayKeyRecord[],
  provided: string,
): LocalGatewayKeyRecord | undefined => records.find((record) => tokenEqual(provided, record.key));
