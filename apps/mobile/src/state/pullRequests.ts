import { createPullRequestEnvironmentAtoms } from "@codework/client-runtime/state/pull-requests";

import { connectionAtomRuntime } from "../connection/runtime";

export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime);
