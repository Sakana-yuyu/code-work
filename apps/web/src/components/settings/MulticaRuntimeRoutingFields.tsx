import { PlusIcon, XIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { MulticaRuntimeDraft } from "./MulticaRuntimeSettings.model";
import type { MulticaRuntimeSettingsText } from "./MulticaRuntimeSettingsText";

interface MulticaRuntimeRoutingFieldsProps {
  readonly text: MulticaRuntimeSettingsText;
  readonly draft: MulticaRuntimeDraft;
  readonly disabled: boolean;
  readonly issuePath: string | null;
  readonly onChange: (draft: MulticaRuntimeDraft) => void;
}

export function MulticaRuntimeRoutingFields({
  text,
  draft,
  disabled,
  issuePath,
  onChange,
}: MulticaRuntimeRoutingFieldsProps) {
  const updateRoutes = (assigneeRoutes: MulticaRuntimeDraft["assigneeRoutes"]) =>
    onChange({ ...draft, assigneeRoutes });

  const updateRoute = (
    index: number,
    patch: Partial<MulticaRuntimeDraft["assigneeRoutes"][number]>,
  ) =>
    updateRoutes(
      draft.assigneeRoutes.map((route, routeIndex) =>
        routeIndex === index ? { ...route, ...patch } : route,
      ),
    );

  return (
    <section className="grid gap-3 border-t border-border/60 pt-4">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h4 className="text-sm font-medium text-foreground">{text("routingSection")}</h4>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          onClick={() =>
            updateRoutes([
              ...draft.assigneeRoutes,
              {
                codeworkAgentId: "",
                codeworkSquadId: "",
                workspaceId: "",
                multicaAgentId: "",
                multicaSquadId: "",
                codeworkMcpCredentialEnvironmentVariable: "",
              },
            ])
          }
          disabled={disabled}
        >
          <PlusIcon />
          {text("addRoute")}
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{text("routingDescription")}</p>
      {draft.assigneeRoutes.length === 0 ? (
        <p className="text-xs text-muted-foreground">{text("emptyRoutes")}</p>
      ) : (
        draft.assigneeRoutes.map((route, index) => {
          // 草稿行没有持久化 ID，且当前只支持追加和删除，索引用于维持本地受控输入顺序。
          const rowKey = `route-${index}`;
          return (
            <div
              key={rowKey}
              className="grid min-w-0 gap-2 rounded-lg border border-border/60 p-2 sm:grid-cols-2 lg:grid-cols-3"
            >
              {(
                [
                  ["codeworkAgentId", "codeworkAgentId"],
                  ["codeworkSquadId", "codeworkSquadId"],
                  ["workspaceId", "workspaceId"],
                  ["multicaAgentId", "multicaAgentId"],
                  ["multicaSquadId", "multicaSquadId"],
                  ["codeworkMcpCredentialEnvironmentVariable", "mcpCredentialEnvironmentVariable"],
                ] as const
              ).map(([field, label]) => (
                <Input
                  key={field}
                  value={route[field]}
                  onChange={(event) => updateRoute(index, { [field]: event.target.value })}
                  disabled={disabled}
                  placeholder={text(label)}
                  aria-label={`${text(label)} ${index + 1}`}
                  aria-invalid={
                    issuePath === `assigneeRoutes.${index}` ||
                    issuePath === `assigneeRoutes.${index}.${field}`
                  }
                  spellCheck={false}
                />
              ))}
              <div className="flex justify-end sm:col-span-2 lg:col-span-3">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={`${text("removeRoute")} ${index + 1}`}
                  onClick={() =>
                    updateRoutes(
                      draft.assigneeRoutes.filter((_, routeIndex) => routeIndex !== index),
                    )
                  }
                  disabled={disabled}
                >
                  <XIcon />
                </Button>
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
