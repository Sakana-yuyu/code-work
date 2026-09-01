import {
  inspectLocalPluginWorkspaceTemplate,
  type LocalPluginWorkspaceContextField,
} from "@codework/contracts";

export interface LocalPluginWorkspaceContext {
  readonly name: string;
  readonly root: string;
}

export function renderLocalPluginTemplate(input: {
  readonly template: string;
  readonly allowedFields: ReadonlyArray<LocalPluginWorkspaceContextField>;
  readonly workspace: LocalPluginWorkspaceContext | null;
}): string {
  const inspection = inspectLocalPluginWorkspaceTemplate(input.template);
  const unsupportedToken = inspection.unsupportedTokens[0];
  if (unsupportedToken !== undefined) {
    throw new Error(`不支持的工作区模板标记 ${unsupportedToken}`);
  }

  const allowedFields = new Set(input.allowedFields);
  const unauthorizedField = inspection.fields.find((field) => !allowedFields.has(field));
  if (unauthorizedField !== undefined) {
    throw new Error(`未授权工作区模板字段 ${unauthorizedField}`);
  }
  if (inspection.fields.length === 0) return input.template;
  if (input.workspace === null) {
    throw new Error("当前没有可用的工作区上下文");
  }

  return input.template
    .replaceAll("{{workspace.name}}", input.workspace.name)
    .replaceAll("{{workspace.root}}", input.workspace.root);
}
