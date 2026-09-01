import type { ProviderInstanceEnvironmentVariable } from "@codework/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

interface MulticaRuntimeCredentialFieldsProps {
  readonly text: MulticaRuntimeSettingsText;
  readonly draft: MulticaRuntimeDraft;
  readonly disabled: boolean;
  readonly issuePath: string | null;
  readonly onChange: (draft: MulticaRuntimeDraft) => void;
}

const hasIssue = (issuePath: string | null, path: string): boolean =>
  issuePath === path || issuePath?.startsWith(`${path}.`) === true;

export function MulticaRuntimeCredentialFields({
  text,
  draft,
  disabled,
  issuePath,
  onChange,
}: MulticaRuntimeCredentialFieldsProps) {
  const update = <K extends keyof MulticaRuntimeDraft>(key: K, value: MulticaRuntimeDraft[K]) =>
    onChange({ ...draft, [key]: value });

  const updateEnvironment = (
    index: number,
    patch: Partial<ProviderInstanceEnvironmentVariable>,
  ) => {
    update(
      "environment",
      draft.environment.map((entry, entryIndex) =>
        entryIndex === index
          ? {
              ...entry,
              ...patch,
              ...(patch.value === undefined ? {} : { valueRedacted: false }),
            }
          : entry,
      ),
    );
  };

  return (
    <section className="grid gap-4 border-t border-border/60 pt-4">
      <h4 className="text-sm font-medium text-foreground">{text("credentialsSection")}</h4>
      <p className="text-xs leading-5 text-muted-foreground">{text("credentialsDescription")}</p>
      <div className="grid gap-2">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <h5 className="text-xs font-medium text-foreground">{text("environment")}</h5>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() =>
              update("environment", [
                ...draft.environment,
                { name: "", value: "", sensitive: true },
              ])
            }
            disabled={disabled}
          >
            <PlusIcon />
            {text("addEnvironment")}
          </Button>
        </div>
        {draft.environment.length === 0 ? (
          <p className="text-xs text-muted-foreground">{text("emptyEnvironment")}</p>
        ) : (
          draft.environment.map((entry, index) => {
            // 草稿行没有持久化 ID，且当前只支持追加和删除，索引用于维持本地受控输入顺序。
            const rowKey = `environment-${index}`;
            return (
              <div
                key={rowKey}
                className="grid min-w-0 gap-2 rounded-lg border border-border/60 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] sm:items-center"
              >
                <Input
                  value={entry.name}
                  onChange={(event) => updateEnvironment(index, { name: event.target.value })}
                  disabled={disabled}
                  placeholder={text("variableName")}
                  aria-label={`${text("variableName")} ${index + 1}`}
                  aria-invalid={hasIssue(issuePath, `environment.${index}.name`)}
                  spellCheck={false}
                />
                <Input
                  value={entry.valueRedacted === true ? "" : entry.value}
                  onChange={(event) => updateEnvironment(index, { value: event.target.value })}
                  disabled={disabled}
                  type={entry.sensitive ? "password" : "text"}
                  placeholder={
                    entry.valueRedacted === true
                      ? text("savedSecretPlaceholder")
                      : text("variableValue")
                  }
                  aria-label={`${text("variableValue")} ${index + 1}`}
                  aria-invalid={hasIssue(issuePath, `environment.${index}.value`)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <label className="flex min-h-7 items-center gap-2 text-xs text-muted-foreground">
                  <Switch
                    checked={entry.sensitive}
                    onCheckedChange={(checked) =>
                      updateEnvironment(index, { sensitive: Boolean(checked) })
                    }
                    disabled={disabled}
                    aria-label={`${text("sensitive")} ${index + 1}`}
                  />
                  {text("sensitive")}
                </label>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`${text("removeEnvironment")} ${index + 1}`}
                  onClick={() =>
                    update(
                      "environment",
                      draft.environment.filter((_, entryIndex) => entryIndex !== index),
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

      <div className="grid gap-2">
        <div className="flex min-h-7 items-center justify-between gap-3">
          <h5 className="text-xs font-medium text-foreground">{text("headers")}</h5>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={() =>
              update("headers", [...draft.headers, { headerName: "", environmentVariable: "" }])
            }
            disabled={disabled}
          >
            <PlusIcon />
            {text("addHeader")}
          </Button>
        </div>
        {draft.headers.length === 0 ? (
          <p className="text-xs text-muted-foreground">{text("emptyHeaders")}</p>
        ) : (
          draft.headers.map((entry, index) => {
            // 草稿行没有持久化 ID，且当前只支持追加和删除，索引用于维持本地受控输入顺序。
            const rowKey = `header-${index}`;
            return (
              <div
                key={rowKey}
                className="grid min-w-0 gap-2 rounded-lg border border-border/60 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <Input
                  value={entry.headerName}
                  onChange={(event) =>
                    update(
                      "headers",
                      draft.headers.map((value, entryIndex) =>
                        entryIndex === index ? { ...value, headerName: event.target.value } : value,
                      ),
                    )
                  }
                  disabled={disabled}
                  placeholder={text("headerName")}
                  aria-label={`${text("headerName")} ${index + 1}`}
                  aria-invalid={hasIssue(issuePath, `headers.${index}.headerName`)}
                  spellCheck={false}
                />
                <Input
                  value={entry.environmentVariable}
                  onChange={(event) =>
                    update(
                      "headers",
                      draft.headers.map((value, entryIndex) =>
                        entryIndex === index
                          ? { ...value, environmentVariable: event.target.value }
                          : value,
                      ),
                    )
                  }
                  disabled={disabled}
                  placeholder={text("environmentVariable")}
                  aria-label={`${text("environmentVariable")} ${index + 1}`}
                  aria-invalid={hasIssue(issuePath, `headers.${index}.environmentVariable`)}
                  spellCheck={false}
                />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`${text("removeHeader")} ${index + 1}`}
                  onClick={() =>
                    update(
                      "headers",
                      draft.headers.filter((_, entryIndex) => entryIndex !== index),
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
    </section>
  );
}
