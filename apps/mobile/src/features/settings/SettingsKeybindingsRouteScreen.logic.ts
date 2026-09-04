import {
  KeybindingCommand,
  type ResolvedKeybindingRule,
  type ServerRemoveKeybindingInput,
  type ServerUpsertKeybindingInput,
} from "@codework/contracts";
import {
  DEFAULT_KEYBINDINGS,
  parseKeybindingShortcut,
  parseKeybindingWhenExpression,
  shortcutToKeybindingInput,
} from "@codework/shared/keybindings";
import * as Schema from "effect/Schema";

const isKeybindingCommand = Schema.is(KeybindingCommand);

export interface MobileKeybindingDraft {
  readonly command: string;
  readonly key: string;
  readonly when: string;
}

export interface MobileKeybindingRow {
  readonly id: string;
  readonly command: ResolvedKeybindingRule["command"];
  readonly key: string;
  readonly when: string;
  readonly binding: ResolvedKeybindingRule;
}

export function keybindingRows(
  keybindings: ReadonlyArray<ResolvedKeybindingRule>,
  query: string,
): ReadonlyArray<MobileKeybindingRow> {
  const normalizedQuery = query.trim().toLowerCase();
  return keybindings
    .map((binding, index) => {
      const key = shortcutToKeybindingInput(binding.shortcut);
      const when = whenExpression(binding.whenAst);
      return {
        id: `${binding.command}\u0000${key}\u0000${when}\u0000${index}`,
        command: binding.command,
        key,
        when,
        binding,
      };
    })
    .filter((row) => {
      if (normalizedQuery.length === 0) return true;
      return (
        String(row.command).toLowerCase().includes(normalizedQuery) ||
        row.key.toLowerCase().includes(normalizedQuery) ||
        row.when.toLowerCase().includes(normalizedQuery)
      );
    });
}

export function whenExpression(node: ResolvedKeybindingRule["whenAst"]): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${wrapWhenExpression(node.node)}`;
    case "and":
      return `${wrapWhenExpression(node.left)} && ${wrapWhenExpression(node.right)}`;
    case "or":
      return `${wrapWhenExpression(node.left)} || ${wrapWhenExpression(node.right)}`;
  }
}

function wrapWhenExpression(node: NonNullable<ResolvedKeybindingRule["whenAst"]>): string {
  if (node.type === "identifier" || node.type === "not") return whenExpression(node);
  return `(${whenExpression(node)})`;
}

export function draftFromKeybindingRow(row: MobileKeybindingRow): MobileKeybindingDraft {
  return { command: String(row.command), key: row.key, when: row.when };
}

export function emptyKeybindingDraft(): MobileKeybindingDraft {
  return { command: "", key: "mod+k", when: "" };
}

export function keybindingInputFromDraft(
  draft: MobileKeybindingDraft,
): ServerUpsertKeybindingInput | null {
  const command = draft.command.trim();
  const key = draft.key.trim();
  const when = draft.when.trim();
  if (!isKeybindingCommand(command) || parseKeybindingShortcut(key) === null) return null;
  if (when.length > 0 && parseKeybindingWhenExpression(when) === null) return null;
  return {
    command,
    key,
    ...(when.length > 0 ? { when } : {}),
  };
}

export function keybindingRemoveTarget(row: MobileKeybindingRow): ServerRemoveKeybindingInput {
  return {
    command: row.command,
    key: row.key,
    ...(row.when.length > 0 ? { when: row.when } : {}),
  };
}

export function defaultKeybindingForRow(row: MobileKeybindingRow) {
  return DEFAULT_KEYBINDINGS.find((binding) => binding.command === row.command);
}
