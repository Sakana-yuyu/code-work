import { WS_METHODS } from "@codework/contracts";
import { createEnvironmentRpcCommand } from "@codework/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const attachmentEnvironment = {
  createUploadUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:attachments:create-upload-url",
    tag: WS_METHODS.attachmentsCreateUploadUrl,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-command:attachments:delete",
    tag: WS_METHODS.attachmentsDelete,
  }),
};
