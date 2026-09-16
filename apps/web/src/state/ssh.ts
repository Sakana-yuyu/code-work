import { createSshServerEnvironmentAtoms } from "@codework/client-runtime/state/ssh-servers";
import { createSshTerminalEnvironmentAtoms } from "@codework/client-runtime/state/ssh-terminal";

import { connectionAtomRuntime } from "../connection/runtime";

export const sshServerEnvironment = createSshServerEnvironmentAtoms(connectionAtomRuntime);
export const sshTerminalEnvironment = createSshTerminalEnvironmentAtoms(connectionAtomRuntime);
