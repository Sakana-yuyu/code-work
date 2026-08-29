import * as Effect from "effect/Effect";

import Migration0042 from "./042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./044_CompositionTasks.ts";
import Migration0045 from "./045_CompositionTaskEventSourceId.ts";
import Migration0046 from "./046_CompositionTaskRunCapabilityGrants.ts";
import Migration0047 from "./047_CompositionCapabilityGrants.ts";
import Migration0048 from "./048_CompositionTaskRunCapabilityHandshake.ts";
import Migration0049 from "./049_CompositionTaskInputs.ts";
import Migration0050 from "./050_CompositionTaskRunRuntimeTaskIndex.ts";
import Migration0051 from "./051_CompositionTaskRunCancelRequestedAt.ts";
import Migration0052 from "./052_CompositionTaskRunLastRuntimeEventAt.ts";
import Migration0053 from "./053_CompositionMulticaQuickCreateIntents.ts";
import Migration0054 from "./054_CompositionMulticaQuickCreateIdempotencyKey.ts";
import Migration0055 from "./055_CompositionTaskOutputCheckpoints.ts";

const canonicalMigrations = [
  Migration0042,
  Migration0043,
  Migration0044,
  Migration0045,
  Migration0046,
  Migration0047,
  Migration0048,
  Migration0049,
  Migration0050,
  Migration0051,
  Migration0052,
  Migration0053,
  Migration0054,
  Migration0055,
] as const;

// 旧数据库可能在 42-55 记录了 Composition-first 历史；逐项重放幂等迁移，
// 只补齐规范 schema，不修改用户已经落库的迁移名称或业务数据。
export default Effect.gen(function* () {
  for (const migration of canonicalMigrations) {
    yield* migration;
  }
});
