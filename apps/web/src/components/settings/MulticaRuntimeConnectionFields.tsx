import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

interface MulticaRuntimeConnectionFieldsProps {
  readonly text: MulticaRuntimeSettingsText;
  readonly mode: "create" | "edit";
  readonly draft: MulticaRuntimeDraft;
  readonly disabled: boolean;
  readonly issuePath: string | null;
  readonly onChange: (draft: MulticaRuntimeDraft) => void;
}

const hasIssue = (issuePath: string | null, path: string): boolean =>
  issuePath === path || issuePath?.startsWith(`${path}.`) === true;

export function MulticaRuntimeConnectionFields({
  text,
  mode,
  draft,
  disabled,
  issuePath,
  onChange,
}: MulticaRuntimeConnectionFieldsProps) {
  const update = <K extends keyof MulticaRuntimeDraft>(key: K, value: MulticaRuntimeDraft[K]) =>
    onChange({ ...draft, [key]: value });

  return (
    <section className="grid gap-3 border-t border-border/60 pt-4">
      <h4 className="text-sm font-medium text-foreground">{text("connectionSection")}</h4>
      <p className="text-xs leading-5 text-muted-foreground">{text("connectionDescription")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
          {text("instanceId")}
          {mode === "create" ? (
            <Input
              value={draft.instanceId}
              onChange={(event) => update("instanceId", event.target.value)}
              disabled={disabled}
              aria-invalid={hasIssue(issuePath, "instanceId")}
              spellCheck={false}
            />
          ) : (
            <code className="min-h-8 break-all rounded-lg border border-input bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              {draft.instanceId}
            </code>
          )}
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
          {text("runtimeId")}
          <Input
            value={draft.runtimeId}
            onChange={(event) => update("runtimeId", event.target.value)}
            disabled={disabled}
            aria-invalid={hasIssue(issuePath, "runtimeId")}
            spellCheck={false}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
          {text("daemonId")}
          <Input
            value={draft.daemonId}
            onChange={(event) => update("daemonId", event.target.value)}
            disabled={disabled}
            aria-invalid={hasIssue(issuePath, "daemonId")}
            spellCheck={false}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
          {text("daemonRuntimeId")}
          <Input
            value={draft.daemonRuntimeId}
            onChange={(event) => update("daemonRuntimeId", event.target.value)}
            disabled={disabled}
            aria-invalid={hasIssue(issuePath, "daemonRuntimeId")}
            spellCheck={false}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground sm:col-span-2">
          {text("baseUrl")}
          <Input
            value={draft.baseUrl}
            onChange={(event) => update("baseUrl", event.target.value)}
            disabled={disabled}
            aria-invalid={hasIssue(issuePath, "baseUrl")}
            inputMode="url"
            spellCheck={false}
          />
        </label>
        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
          {text("version")}
          <Input
            value={draft.version}
            onChange={(event) => update("version", event.target.value)}
            disabled={disabled}
            spellCheck={false}
          />
        </label>
        <label className="flex min-h-8 items-center justify-between gap-3 rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground">
          {text("enableRuntime")}
          <Switch
            checked={draft.enabled}
            onCheckedChange={(checked) => update("enabled", Boolean(checked))}
            disabled={disabled}
          />
        </label>
      </div>
    </section>
  );
}
