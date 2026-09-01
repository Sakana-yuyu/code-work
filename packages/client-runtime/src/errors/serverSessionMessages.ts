/**
 * 服务端拿不到 UI 语言，会话级错误以英文原句写入 `session.lastError`。
 * 这里把已知句子映射为稳定 i18n key 与插值参数，客户端展示前翻译；
 * 未知文案返回 null，由调用方原样展示（对未来新增的服务端错误保持透传）。
 * 服务端新增 lastError 文案时在此登记（精确句或正则模板）。
 */
export interface ServerSessionErrorTranslation {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

const EXACT_KEYS: ReadonlyArray<{
  readonly message: string;
  readonly key: string;
}> = [
  {
    message: "Provider session did not survive a server restart. Send a new message to continue.",
    key: "session.providerSessionLostAfterRestart",
  },
  {
    message: "Provider session error",
    key: "session.providerSessionError",
  },
  {
    message: "Turn failed",
    key: "session.turnFailed",
  },
  {
    message: "No active provider session is bound to this thread.",
    key: "session.noActiveProviderSession",
  },
];

const TEMPLATE_KEYS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly key: string;
  readonly params: (matches: ReadonlyArray<string>) => Record<string, string>;
}> = [
  {
    pattern:
      /^Thread '([^']+)' cannot switch models after the conversation has started\. Start a new thread to use '([^']+)'\.$/,
    key: "session.cannotSwitchModelsAfterStart",
    params: (m) => ({ threadId: m[1]!, model: m[2]! }),
  },
  {
    pattern: /^Thread '([^']+)' has an active provider session without a provider instance id\.$/,
    key: "session.activeSessionWithoutInstanceId",
    params: (m) => ({ threadId: m[1]! }),
  },
  {
    pattern:
      /^Thread '([^']+)' references unknown provider instance '([^']+)'\. The instance is not configured in this build\.$/,
    key: "session.unknownProviderInstance",
    params: (m) => ({ threadId: m[1]!, instanceId: m[2]! }),
  },
  {
    pattern: /^Requested provider instance '([^']+)' is not configured in this build\.$/,
    key: "session.providerInstanceNotConfigured",
    params: (m) => ({ instanceId: m[1]! }),
  },
  {
    pattern:
      /^Requested provider instance '([^']+)' uses unknown provider driver '([^']+)'\. The driver is not installed in this build\.$/,
    key: "session.unknownProviderDriver",
    params: (m) => ({ instanceId: m[1]!, driverKind: m[2]! }),
  },
  {
    pattern: /^Thread '([^']+)' is bound to driver '([^']+)' and cannot switch to '([^']+)'\.$/,
    key: "session.driverSwitchUnsupported",
    params: (m) => ({ threadId: m[1]!, currentDriverKind: m[2]!, desiredDriverKind: m[3]! }),
  },
  {
    pattern:
      /^Thread '([^']+)' cannot switch from instance '([^']+)' to '([^']+)' because their provider resume state is incompatible\.$/,
    key: "session.instanceSwitchIncompatible",
    params: (m) => ({ threadId: m[1]!, currentInstanceId: m[2]!, desiredInstanceId: m[3]! }),
  },
  {
    pattern: /^Provider session '([^']+)' started without a provider instance id\.$/,
    key: "session.sessionStartedWithoutInstanceId",
    params: (m) => ({ threadId: m[1]! }),
  },
  {
    pattern: /^Active provider session '([^']+)' is missing a provider instance id\.$/,
    key: "session.activeSessionMissingInstanceId",
    params: (m) => ({ threadId: m[1]! }),
  },
  {
    pattern: /^User message '([^']+)' was not found for turn start request\.$/,
    key: "session.userMessageNotFoundForTurnStart",
    params: (m) => ({ messageId: m[1]! }),
  },
];

export function serverSessionErrorTranslation(
  message: string,
): ServerSessionErrorTranslation | null {
  for (const entry of EXACT_KEYS) {
    if (entry.message === message) return { key: entry.key, params: {} };
  }
  for (const entry of TEMPLATE_KEYS) {
    const matches = entry.pattern.exec(message);
    if (matches !== null) {
      return { key: entry.key, params: entry.params([...matches]) };
    }
  }
  return null;
}
