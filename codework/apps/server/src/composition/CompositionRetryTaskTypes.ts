import type {
  CompositionCapabilityGrant,
  CompositionTask,
  CompositionTaskRetryRequest,
  CompositionTaskRetryResult,
  CompositionTaskRun,
} from "@codework/contracts";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type {
  CompositionRunStartStoreError,
  CompositionRunStartStoreShape,
} from "../persistence/Services/CompositionRunStartStore.ts";
import type {
  CompositionTaskInputStoreError,
  CompositionTaskInputStoreShape,
} from "../persistence/Services/CompositionTaskInputStore.ts";
import type {
  CompositionTaskStoreError,
  CompositionTaskStoreShape,
} from "../persistence/Services/CompositionTaskStore.ts";
import type { CompositionAgentDriverRegistry } from "./CompositionAgentDriverRegistry.ts";
import type * as CapabilityGrantRegistry from "./CapabilityGrantRegistry.ts";
import type * as CapabilityRegistry from "./CapabilityRegistry.ts";
import type { CompositionAgentDriver } from "./CompositionOrchestrator.ts";
import type {
  CompositionAgentDriverFailure,
  CompositionTaskNotFoundError,
  CompositionTaskRetryInvalidError,
} from "./CompositionOrchestratorErrors.ts";

export type CompositionAgentDriverStartResult = {
  readonly runtimeTaskId?: string;
  readonly capabilityHandshakeId?: string;
};

export type CompositionRetryTaskError =
  | CompositionTaskStoreError
  | CompositionTaskNotFoundError
  | CompositionTaskRetryInvalidError
  | CompositionAgentDriverFailure
  | CompositionTaskInputStoreError
  | CapabilityGrantRegistry.CapabilityGrantInvalidError
  | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  | CapabilityRegistry.CapabilityScopeNotFoundError
  | CapabilityRegistry.CapabilityRegistryUnavailableError
  | CompositionRunStartStoreError;

export type CompositionRetryTask = (
  input: CompositionTaskRetryRequest,
) => Effect.Effect<CompositionTaskRetryResult, CompositionRetryTaskError>;

export interface CompositionRetryTaskOperations {
  readonly prepareRunLease: (
    task: CompositionTask,
    run: CompositionTaskRun,
    workspaceRootDigest: string | undefined,
  ) => Effect.Effect<Option.Option<CompositionTaskRun>, CompositionTaskStoreError>;
  readonly releaseRunLease: (
    run: CompositionTaskRun,
  ) => Effect.Effect<void, CompositionTaskStoreError>;
  readonly revokeRunCapabilities: (
    driver: CompositionAgentDriver | undefined,
    task: CompositionTask,
    run: CompositionTaskRun,
  ) => Effect.Effect<
    void,
    | CompositionTaskStoreError
    | CompositionAgentDriverFailure
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  >;
  readonly persistCapabilityGrantProjection: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly sourceEventId: string;
    readonly summary: string;
  }) => Effect.Effect<void, CompositionTaskStoreError>;
  readonly describeIssuedGrants: (grants: ReadonlyArray<CompositionCapabilityGrant>) => string;
  readonly persistStartedRun: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly runtimeId: string;
    readonly startResult: CompositionAgentDriverStartResult;
    readonly summary: string;
    readonly expectedPreStartStatus?: CompositionTask["status"];
  }) => Effect.Effect<CompositionTaskRetryResult, CompositionTaskStoreError>;
  readonly persistFailedStart: (input: {
    readonly task: CompositionTask;
    readonly run: CompositionTaskRun;
    readonly driver: CompositionAgentDriver;
    readonly failure: CompositionAgentDriverFailure;
    readonly summary: string;
    readonly finishTask: boolean;
  }) => Effect.Effect<
    CompositionTaskRetryResult,
    | CompositionTaskStoreError
    | CompositionAgentDriverFailure
    | CapabilityGrantRegistry.CapabilityGrantPersistenceError
  >;
}

export interface CompositionRetryTaskOptions {
  readonly store: CompositionTaskStoreShape;
  readonly driverRegistry: CompositionAgentDriverRegistry;
  readonly grantRegistry?: Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "issue"> &
    Partial<Pick<CapabilityGrantRegistry.CapabilityGrantRegistryShape, "revoke">>;
  readonly inputStore?: CompositionTaskInputStoreShape;
  readonly runStartStore?: CompositionRunStartStoreShape;
  readonly operations: CompositionRetryTaskOperations;
}
