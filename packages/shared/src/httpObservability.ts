import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Headers from "effect/http/Headers";
import * as HttpMiddleware from "effect/http/HttpMiddleware";

export const httpHeaderRedactionLayer = Layer.mergeAll(
  Layer.effect(
    Headers.CurrentRedactedNames,
    Effect.map(Headers.CurrentRedactedNames, (names) => [...names, "dpop"]),
  ),
  // effect 4.0.6 起服务端 span 的 header 采集默认关闭（TracerHeaderFilter
  // 默认不采集任何 header）。这里恢复既有语义：全量采集，敏感头按
  // CurrentRedactedNames 以 <redacted> 落盘。
  Layer.effect(
    HttpMiddleware.TracerHeaderFilter,
    Effect.succeed(() => true),
  ),
);
