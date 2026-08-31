import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

interface MulticaRuntimeCapabilityFieldsProps {
  readonly text: MulticaRuntimeSettingsText;
  readonly draft: MulticaRuntimeDraft;
  readonly disabled: boolean;
  readonly issuePath: string | null;
  readonly onChange: (draft: MulticaRuntimeDraft) => void;
}

const capabilitySwitches = [
  ["supportsResume", "supportsResume"],
  ["supportsMcp", "supportsMcp"],
  ["supportsSquad", "supportsSquad"],
  ["supportsLeader", "supportsLeader"],
  ["supportsTaskGraph", "supportsTaskGraph"],
] as const;

export function MulticaRuntimeCapabilityFields({
  text,
  draft,
  disabled,
  issuePath,
  onChange,
}: MulticaRuntimeCapabilityFieldsProps) {
  const update = <K extends keyof MulticaRuntimeDraft>(key: K, value: MulticaRuntimeDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const updateCapabilityFlag = (key: (typeof capabilitySwitches)[number][0], checked: boolean) => {
    if (key !== "supportsMcp" || checked) {
      update(key, checked);
      return;
    }
    onChange({
      ...draft,
      supportsMcp: false,
      taskMcpEndpoint: "",
      assigneeRoutes: draft.assigneeRoutes.map((route) => ({
        ...route,
        codeworkMcpCredentialEnvironmentVariable: "",
      })),
    });
  };

  const extension = draft.taskExecutionExtension;
  const updateExtension = (patch: Partial<MulticaRuntimeDraft["taskExecutionExtension"]>) =>
    update("taskExecutionExtension", { ...extension, ...patch });

  return (
    <>
      <section className="grid gap-4 border-t border-border/60 pt-4">
        <h4 className="text-sm font-medium text-foreground">{text("capabilitiesSection")}</h4>
        <div className="grid gap-2">
          <div className="flex min-h-7 items-center justify-between gap-3">
            <h5 className="text-xs font-medium text-foreground">{text("capabilityList")}</h5>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => update("capabilities", [...draft.capabilities, ""])}
              disabled={disabled}
            >
              <PlusIcon />
              {text("addCapability")}
            </Button>
          </div>
          {draft.capabilities.length === 0 ? (
            <p className="text-xs text-muted-foreground">{text("emptyCapabilities")}</p>
          ) : (
            draft.capabilities.map((capability, index) => {
              // 草稿能力尚未保存且只支持追加和删除，位置键避免输入时因值变化重挂载。
              const rowKey = `capability-${index}`;
              return (
                <div key={rowKey} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
                  <Input
                    value={capability}
                    onChange={(event) =>
                      update(
                        "capabilities",
                        draft.capabilities.map((value, entryIndex) =>
                          entryIndex === index ? event.target.value : value,
                        ),
                      )
                    }
                    disabled={disabled}
                    placeholder={text("capability")}
                    aria-label={`${text("capability")} ${index + 1}`}
                    spellCheck={false}
                  />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={`${text("removeCapability")} ${index + 1}`}
                    onClick={() =>
                      update(
                        "capabilities",
                        draft.capabilities.filter((_, entryIndex) => entryIndex !== index),
                      )
                    }
                    disabled={disabled}
                  >
                    <XIcon />
                  </Button>
                </div>
              );
            })
          )}
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {capabilitySwitches.map(([key, label]) => (
            <label
              key={key}
              className="flex min-h-9 items-center justify-between gap-3 rounded-lg border border-border/60 px-3 text-xs font-medium text-foreground"
            >
              {text(label)}
              <Switch
                checked={draft[key]}
                onCheckedChange={(checked) => updateCapabilityFlag(key, Boolean(checked))}
                disabled={disabled}
              />
            </label>
          ))}
        </div>

        <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
          {text("taskMcpEndpoint")}
          <Input
            value={draft.taskMcpEndpoint}
            onChange={(event) => update("taskMcpEndpoint", event.target.value)}
            disabled={disabled || !draft.supportsMcp}
            aria-invalid={issuePath === "taskMcpEndpoint"}
            inputMode="url"
            spellCheck={false}
          />
        </label>
      </section>

      <section className="grid gap-3 border-t border-border/60 pt-4">
        <h4 className="text-sm font-medium text-foreground">{text("executionSection")}</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
            {text("extensionCommand")}
            <Input
              value={extension.command}
              onChange={(event) => updateExtension({ command: event.target.value })}
              disabled={disabled}
              aria-invalid={issuePath === "taskExecutionExtension.command"}
              spellCheck={false}
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
            {text("extensionCwd")}
            <Input
              value={extension.cwd}
              onChange={(event) => updateExtension({ cwd: event.target.value })}
              disabled={disabled}
              spellCheck={false}
            />
          </label>
          <label className="grid min-w-0 gap-1.5 text-xs font-medium text-foreground">
            {text("extensionTimeoutMs")}
            <Input
              value={extension.timeoutMs}
              onChange={(event) => updateExtension({ timeoutMs: event.target.value })}
              disabled={disabled}
              aria-invalid={issuePath === "taskExecutionExtension.timeoutMs"}
              inputMode="numeric"
            />
          </label>
        </div>
        <div className="grid gap-2">
          <div className="flex min-h-7 items-center justify-end">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => updateExtension({ args: [...extension.args, ""] })}
              disabled={disabled}
            >
              <PlusIcon />
              {text("addExtensionArgument")}
            </Button>
          </div>
          {extension.args.map((argument, index) => {
            // 参数草稿允许重复值且只支持追加和删除，位置键不会随输入内容变化。
            const rowKey = `extension-argument-${index}`;
            return (
              <div key={rowKey} className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  value={argument}
                  onChange={(event) =>
                    updateExtension({
                      args: extension.args.map((value, entryIndex) =>
                        entryIndex === index ? event.target.value : value,
                      ),
                    })
                  }
                  disabled={disabled}
                  placeholder={text("extensionArgument")}
                  aria-label={`${text("extensionArgument")} ${index + 1}`}
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`${text("removeExtensionArgument")} ${index + 1}`}
                  onClick={() =>
                    updateExtension({
                      args: extension.args.filter((_, entryIndex) => entryIndex !== index),
                    })
                  }
                  disabled={disabled}
                >
                  <XIcon />
                </Button>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
