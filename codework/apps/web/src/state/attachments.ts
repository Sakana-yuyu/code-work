import { WS_METHODS } from "@codework/contracts";
import { createEnvironmentRpcCommand } from "@codework/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { t } from "~/i18n/runtime";

export const attachmentEnvironment = {
  createUploadUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    get label() {
      return t("environmentCommandAttachmentsCreateUploadUrl");
    },
    tag: WS_METHODS.attachmentsCreateUploadUrl,
  }),
  remove: createEnvironmentRpcCommand(connectionAtomRuntime, {
    get label() {
      return t("environmentCommandAttachmentsDelete");
    },
    tag: WS_METHODS.attachmentsDelete,
  }),
};
