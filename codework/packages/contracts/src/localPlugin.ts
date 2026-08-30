import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LOCAL_PLUGIN_MANIFEST_VERSION = 1 as const;
export const LOCAL_PLUGIN_HOST_API_VERSION = { major: 1, minor: 0 } as const;

const LOCAL_PLUGIN_MAX_CONTRIBUTIONS_PER_KIND = 32;
const LOCAL_PLUGIN_MAX_ATTACHMENT_BYTES = 20_000_000;
const LOCAL_PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
const LOCAL_PLUGIN_SEMVER_NUMBER = "(?:0|[1-9][0-9]*)";
const LOCAL_PLUGIN_SEMVER_PRERELEASE = `(?:${LOCAL_PLUGIN_SEMVER_NUMBER}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const LOCAL_PLUGIN_VERSION_PATTERN = new RegExp(
  `^${LOCAL_PLUGIN_SEMVER_NUMBER}\\.${LOCAL_PLUGIN_SEMVER_NUMBER}\\.${LOCAL_PLUGIN_SEMVER_NUMBER}` +
    `(?:-${LOCAL_PLUGIN_SEMVER_PRERELEASE}(?:\\.${LOCAL_PLUGIN_SEMVER_PRERELEASE})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);

const LocalPluginId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(96),
  Schema.isPattern(LOCAL_PLUGIN_ID_PATTERN),
);
const LocalPluginDisplayText = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
const LocalPluginContentText = TrimmedNonEmptyString.check(Schema.isMaxLength(4_000));
const LocalPluginContributionArray = <A extends Schema.Top>(schema: A) =>
  Schema.Array(schema).check(Schema.isMaxLength(LOCAL_PLUGIN_MAX_CONTRIBUTIONS_PER_KIND));

export const LocalPluginApiVersion = Schema.Struct({
  major: NonNegativeInt.check(Schema.isLessThanOrEqualTo(999)),
  minor: NonNegativeInt.check(Schema.isLessThanOrEqualTo(999)),
});
export type LocalPluginApiVersion = typeof LocalPluginApiVersion.Type;

export const LocalPluginPermission = Schema.Literals([
  "workspace.read",
  "clipboard.write",
  "composer.prompt.write",
  "timeline.write",
  "composer.attachment.add",
]);
export type LocalPluginPermission = typeof LocalPluginPermission.Type;

export const LocalPluginWorkspaceContextField = Schema.Literals([
  "workspace.name",
  "workspace.root",
]);
export type LocalPluginWorkspaceContextField = typeof LocalPluginWorkspaceContextField.Type;

export interface LocalPluginWorkspaceTemplateInspection {
  readonly fields: ReadonlyArray<LocalPluginWorkspaceContextField>;
  readonly unsupportedTokens: ReadonlyArray<string>;
}

const LOCAL_PLUGIN_WORKSPACE_TEMPLATE_PATTERN = /\{\{workspace\.([^{}]+)\}\}/g;
const LOCAL_PLUGIN_WORKSPACE_CONTEXT_FIELDS = new Set<LocalPluginWorkspaceContextField>([
  "workspace.name",
  "workspace.root",
]);

export function inspectLocalPluginWorkspaceTemplate(
  text: string,
): LocalPluginWorkspaceTemplateInspection {
  const fields = new Set<LocalPluginWorkspaceContextField>();
  const unsupportedTokens = new Set<string>();
  for (const match of text.matchAll(LOCAL_PLUGIN_WORKSPACE_TEMPLATE_PATTERN)) {
    const token = match[0];
    const field = `workspace.${match[1]}`;
    if (LOCAL_PLUGIN_WORKSPACE_CONTEXT_FIELDS.has(field as LocalPluginWorkspaceContextField)) {
      fields.add(field as LocalPluginWorkspaceContextField);
    } else {
      unsupportedTokens.add(token);
    }
  }
  return { fields: [...fields], unsupportedTokens: [...unsupportedTokens] };
}

export const LocalPluginWorkspacePanelContribution = Schema.Struct({
  id: LocalPluginId,
  title: LocalPluginDisplayText,
  description: Schema.optionalKey(LocalPluginDisplayText),
  sections: LocalPluginContributionArray(
    Schema.Struct({
      heading: Schema.optionalKey(LocalPluginDisplayText),
      body: LocalPluginContentText,
    }),
  ).check(Schema.isMinLength(1)),
  context: Schema.optionalKey(
    Schema.Array(LocalPluginWorkspaceContextField).check(Schema.isMaxLength(2)),
  ),
});
export type LocalPluginWorkspacePanelContribution =
  typeof LocalPluginWorkspacePanelContribution.Type;

export const LocalPluginCommandAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("workspace.open-panel"),
    panelId: LocalPluginId,
  }),
  Schema.Struct({
    type: Schema.Literal("clipboard.write"),
    text: LocalPluginContentText,
  }),
  Schema.Struct({
    type: Schema.Literal("composer.prompt.insert"),
    text: LocalPluginContentText,
  }),
  Schema.Struct({
    type: Schema.Literal("timeline.post"),
    timelineId: LocalPluginId,
    message: LocalPluginContentText,
  }),
]);
export type LocalPluginCommandAction = typeof LocalPluginCommandAction.Type;

export const LocalPluginCommandContribution = Schema.Struct({
  id: LocalPluginId,
  title: LocalPluginDisplayText,
  description: Schema.optionalKey(LocalPluginDisplayText),
  action: LocalPluginCommandAction,
});
export type LocalPluginCommandContribution = typeof LocalPluginCommandContribution.Type;

export const LocalPluginTimelineContribution = Schema.Struct({
  id: LocalPluginId,
  title: LocalPluginDisplayText,
  tone: Schema.Literals(["info", "success", "warning", "error"]),
});
export type LocalPluginTimelineContribution = typeof LocalPluginTimelineContribution.Type;

export const LocalPluginAttachmentContribution = Schema.Struct({
  id: LocalPluginId,
  title: LocalPluginDisplayText,
  description: Schema.optionalKey(LocalPluginDisplayText),
  accept: Schema.Array(
    Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"]),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
  maxBytes: PositiveInt.check(Schema.isLessThanOrEqualTo(LOCAL_PLUGIN_MAX_ATTACHMENT_BYTES)),
  promptPrefix: Schema.optionalKey(LocalPluginContentText),
});
export type LocalPluginAttachmentContribution = typeof LocalPluginAttachmentContribution.Type;

export const LocalPluginContributions = Schema.Struct({
  workspacePanels: Schema.optionalKey(
    LocalPluginContributionArray(LocalPluginWorkspacePanelContribution),
  ),
  commands: Schema.optionalKey(LocalPluginContributionArray(LocalPluginCommandContribution)),
  timeline: Schema.optionalKey(LocalPluginContributionArray(LocalPluginTimelineContribution)),
  attachments: Schema.optionalKey(LocalPluginContributionArray(LocalPluginAttachmentContribution)),
});
export type LocalPluginContributions = typeof LocalPluginContributions.Type;

export const LocalPluginManifest = Schema.Struct({
  manifestVersion: Schema.Literal(LOCAL_PLUGIN_MANIFEST_VERSION),
  apiVersion: LocalPluginApiVersion,
  id: LocalPluginId,
  name: LocalPluginDisplayText,
  version: Schema.String.check(
    Schema.isMaxLength(96),
    Schema.isPattern(LOCAL_PLUGIN_VERSION_PATTERN),
  ),
  permissions: Schema.Array(LocalPluginPermission).check(Schema.isMaxLength(8)),
  contributions: LocalPluginContributions,
});
export type LocalPluginManifest = typeof LocalPluginManifest.Type;

export type LocalPluginApiCompatibility =
  | {
      readonly compatible: true;
      readonly host: typeof LOCAL_PLUGIN_HOST_API_VERSION;
    }
  | {
      readonly compatible: false;
      readonly host: typeof LOCAL_PLUGIN_HOST_API_VERSION;
      readonly requested: LocalPluginApiVersion;
      readonly reason: "unsupported-major" | "requires-newer-minor";
    };

export function negotiateLocalPluginApiVersion(
  requested: LocalPluginApiVersion,
): LocalPluginApiCompatibility {
  if (requested.major !== LOCAL_PLUGIN_HOST_API_VERSION.major) {
    return {
      compatible: false,
      host: LOCAL_PLUGIN_HOST_API_VERSION,
      requested,
      reason: "unsupported-major",
    };
  }
  if (requested.minor > LOCAL_PLUGIN_HOST_API_VERSION.minor) {
    return {
      compatible: false,
      host: LOCAL_PLUGIN_HOST_API_VERSION,
      requested,
      reason: "requires-newer-minor",
    };
  }
  return { compatible: true, host: LOCAL_PLUGIN_HOST_API_VERSION };
}

export type LocalPluginManifestIssueCode =
  | "api-incompatible"
  | "duplicate-permission"
  | "duplicate-contribution-id"
  | "missing-permission"
  | "missing-workspace-panel"
  | "missing-timeline-contribution"
  | "undeclared-workspace-context"
  | "unsupported-workspace-context";

export interface LocalPluginManifestIssue {
  readonly code: LocalPluginManifestIssueCode;
  readonly path: string;
  readonly message: string;
}

function requiredPermissions(manifest: LocalPluginManifest): Map<LocalPluginPermission, string> {
  const required = new Map<LocalPluginPermission, string>();
  const require = (permission: LocalPluginPermission, path: string) => {
    if (!required.has(permission)) required.set(permission, path);
  };

  for (const panel of manifest.contributions.workspacePanels ?? []) {
    if ((panel.context?.length ?? 0) > 0) {
      require("workspace.read", `contributions.workspacePanels.${panel.id}.context`);
    }
  }
  for (const command of manifest.contributions.commands ?? []) {
    switch (command.action.type) {
      case "workspace.open-panel":
        break;
      case "clipboard.write":
        require("clipboard.write", `contributions.commands.${command.id}.action`);
        if (command.action.text.includes("{{workspace.")) {
          require("workspace.read", `contributions.commands.${command.id}.action.text`);
        }
        break;
      case "composer.prompt.insert":
        require("composer.prompt.write", `contributions.commands.${command.id}.action`);
        break;
      case "timeline.post":
        require("timeline.write", `contributions.commands.${command.id}.action`);
        break;
    }
  }
  for (const attachment of manifest.contributions.attachments ?? []) {
    require("composer.attachment.add", `contributions.attachments.${attachment.id}`);
    if (attachment.promptPrefix !== undefined) {
      require("composer.prompt.write", `contributions.attachments.${attachment.id}.promptPrefix`);
    }
  }
  return required;
}

function duplicateIds(values: ReadonlyArray<{ readonly id: string }>): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) duplicates.add(value.id);
    seen.add(value.id);
  }
  return [...duplicates];
}

export function validateLocalPluginManifest(
  manifest: LocalPluginManifest,
): LocalPluginManifestIssue[] {
  const issues: LocalPluginManifestIssue[] = [];
  const compatibility = negotiateLocalPluginApiVersion(manifest.apiVersion);
  if (!compatibility.compatible) {
    issues.push({
      code: "api-incompatible",
      path: "apiVersion",
      message: `插件 API ${manifest.apiVersion.major}.${manifest.apiVersion.minor} 与宿主 ${LOCAL_PLUGIN_HOST_API_VERSION.major}.${LOCAL_PLUGIN_HOST_API_VERSION.minor} 不兼容。`,
    });
  }

  for (const permission of duplicateIds(manifest.permissions.map((id) => ({ id })))) {
    issues.push({
      code: "duplicate-permission",
      path: "permissions",
      message: `权限 ${permission} 重复声明。`,
    });
  }

  const contributionGroups = [
    ["workspacePanels", manifest.contributions.workspacePanels ?? []],
    ["commands", manifest.contributions.commands ?? []],
    ["timeline", manifest.contributions.timeline ?? []],
    ["attachments", manifest.contributions.attachments ?? []],
  ] as const;
  for (const [kind, contributions] of contributionGroups) {
    for (const id of duplicateIds(contributions)) {
      issues.push({
        code: "duplicate-contribution-id",
        path: `contributions.${kind}`,
        message: `${kind} 贡献 ID ${id} 重复。`,
      });
    }
  }

  for (const panel of manifest.contributions.workspacePanels ?? []) {
    const declaredContext = new Set(panel.context ?? []);
    const templateTexts = [
      ...(panel.description === undefined
        ? []
        : [
            {
              path: `contributions.workspacePanels.${panel.id}.description`,
              text: panel.description,
            },
          ]),
      ...panel.sections.flatMap((section, index) => [
        ...(section.heading === undefined
          ? []
          : [
              {
                path: `contributions.workspacePanels.${panel.id}.sections.${index}.heading`,
                text: section.heading,
              },
            ]),
        {
          path: `contributions.workspacePanels.${panel.id}.sections.${index}.body`,
          text: section.body,
        },
      ]),
    ];
    for (const template of templateTexts) {
      const inspection = inspectLocalPluginWorkspaceTemplate(template.text);
      for (const token of inspection.unsupportedTokens) {
        issues.push({
          code: "unsupported-workspace-context",
          path: template.path,
          message: `工作区面板使用了不支持的模板标记 ${token}。`,
        });
      }
      for (const field of inspection.fields) {
        if (declaredContext.has(field)) continue;
        issues.push({
          code: "undeclared-workspace-context",
          path: template.path,
          message: `工作区面板模板字段 ${field} 未在 context 中声明。`,
        });
      }
    }
  }

  for (const command of manifest.contributions.commands ?? []) {
    if (command.action.type !== "clipboard.write") continue;
    const inspection = inspectLocalPluginWorkspaceTemplate(command.action.text);
    for (const token of inspection.unsupportedTokens) {
      issues.push({
        code: "unsupported-workspace-context",
        path: `contributions.commands.${command.id}.action.text`,
        message: `命令使用了不支持的工作区模板标记 ${token}。`,
      });
    }
  }

  const declaredPermissions = new Set(manifest.permissions);
  for (const [permission, path] of requiredPermissions(manifest)) {
    if (!declaredPermissions.has(permission)) {
      issues.push({
        code: "missing-permission",
        path,
        message: `贡献需要声明权限 ${permission}。`,
      });
    }
  }

  const panelIds = new Set(
    (manifest.contributions.workspacePanels ?? []).map((contribution) => contribution.id),
  );
  const timelineIds = new Set(
    (manifest.contributions.timeline ?? []).map((contribution) => contribution.id),
  );
  for (const command of manifest.contributions.commands ?? []) {
    if (command.action.type === "workspace.open-panel" && !panelIds.has(command.action.panelId)) {
      issues.push({
        code: "missing-workspace-panel",
        path: `contributions.commands.${command.id}.action.panelId`,
        message: `命令引用了不存在的工作区面板 ${command.action.panelId}。`,
      });
    }
    if (command.action.type === "timeline.post" && !timelineIds.has(command.action.timelineId)) {
      issues.push({
        code: "missing-timeline-contribution",
        path: `contributions.commands.${command.id}.action.timelineId`,
        message: `命令引用了不存在的 Timeline 贡献 ${command.action.timelineId}。`,
      });
    }
  }

  return issues;
}
