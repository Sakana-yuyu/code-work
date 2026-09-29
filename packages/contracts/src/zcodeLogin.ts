import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * ZCode 官方账号登录（服务端原生实现，不依赖 zcode CLI）。
 *
 * `start` 由服务端完成 OAuth init 并在后台轮询，客户端拿到 `authorizeUrl` 后
 * 引导用户浏览器授权；`status` 轮询会话状态，`ready` 时凭据已写入服务端
 * 对应目录（实例受管数据根或号池一次性登录目录）。
 */

export const ZCodeLoginFamily = Schema.Literals(["zai", "bigmodel"]);
export type ZCodeLoginFamily = typeof ZCodeLoginFamily.Type;

export const ZCodeLoginStartPayload = Schema.Struct({
  action: Schema.Literal("start"),
  family: ZCodeLoginFamily,
  /** 号池登录：凭据写入按 sessionId 建立的一次性目录（随后走 importLocalLogin 导入）。 */
  poolLogin: Schema.optional(Schema.Boolean),
  /** 实例官方登录：凭据写入该实例的受管 ZCode 数据根。 */
  instanceId: Schema.optional(ProviderInstanceId),
});
export type ZCodeLoginStartPayload = typeof ZCodeLoginStartPayload.Type;

export const ZCodeLoginStatusPayload = Schema.Struct({
  action: Schema.Literal("status"),
  sessionId: Schema.String,
});
export type ZCodeLoginStatusPayload = typeof ZCodeLoginStatusPayload.Type;

export const ZCodeLoginCancelPayload = Schema.Struct({
  action: Schema.Literal("cancel"),
  sessionId: Schema.String,
});
export type ZCodeLoginCancelPayload = typeof ZCodeLoginCancelPayload.Type;

export const ZCodeLoginRequest = Schema.Union([
  ZCodeLoginStartPayload,
  ZCodeLoginStatusPayload,
  ZCodeLoginCancelPayload,
]);
export type ZCodeLoginRequest = typeof ZCodeLoginRequest.Type;

export const ZCodeLoginUser = Schema.Struct({
  userId: Schema.String,
  email: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  avatar: Schema.optional(Schema.String),
});
export type ZCodeLoginUser = typeof ZCodeLoginUser.Type;

export const ZCodeLoginStartResult = Schema.Struct({
  action: Schema.Literal("start"),
  sessionId: Schema.String,
  authorizeUrl: Schema.String,
  expiresAtSec: Schema.Number,
});
export type ZCodeLoginStartResult = typeof ZCodeLoginStartResult.Type;

export const ZCodeLoginStatusResult = Schema.Struct({
  action: Schema.Literal("status"),
  status: Schema.Literals(["waiting", "ready", "failed", "expired", "cancelled"]),
  user: Schema.optional(ZCodeLoginUser),
  /** 失败/过期时的可读原因。 */
  message: Schema.optional(Schema.String),
});
export type ZCodeLoginStatusResult = typeof ZCodeLoginStatusResult.Type;

export const ZCodeLoginResult = Schema.Union([ZCodeLoginStartResult, ZCodeLoginStatusResult]);
export type ZCodeLoginResult = typeof ZCodeLoginResult.Type;

export class ZCodeLoginContractError extends Schema.TaggedErrorClass<ZCodeLoginContractError>()(
  "ZCodeLoginContractError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
