/**
 * Product-level agent tools on Integrations: memory, lifecycle hooks, web search.
 *
 * @module AgentToolsSettings
 */
import {
  AGENT_HOOK_EVENTS,
  DEFAULT_UNIFIED_SETTINGS,
  WEB_SEARCH_ENGINES,
  type AgentHookEntry,
  type AgentHookEvent,
  type WebSearchEngine,
} from "@codework/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { t } from "~/i18n";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const HOOK_EVENT_LABELS: Readonly<Record<AgentHookEvent, string>> = {
  user_prompt_submit: "agentHooks.event.userPromptSubmit",
  pre_tool_use: "agentHooks.event.preToolUse",
  post_tool_use: "agentHooks.event.postToolUse",
  stop: "agentHooks.event.stop",
};

const ENGINE_LABELS: Readonly<Record<WebSearchEngine, string>> = {
  duckduckgo: "webSearch.engine.duckduckgo",
  searxng: "webSearch.engine.searxng",
  tavily: "webSearch.engine.tavily",
  brave: "webSearch.engine.brave",
};

export function AgentMemorySettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const memory = settings.agentMemory;
  const defaults = DEFAULT_UNIFIED_SETTINGS.agentMemory;

  return (
    <SettingsSection id="agent-memory" title={t("agentMemory.title")}>
      <p className="text-xs text-muted-foreground">{t("agentMemory.explanation")}</p>
      <SettingsRow
        title={t("agentMemory.toggle")}
        description={t("agentMemory.toggleDescription")}
        resetAction={
          memory.enabled !== defaults.enabled ? (
            <SettingResetButton
              label={t("agentMemory.toggle")}
              onClick={() => updateSettings({ agentMemory: { enabled: defaults.enabled } })}
            />
          ) : null
        }
        control={
          <Switch
            checked={memory.enabled}
            onCheckedChange={(checked) =>
              updateSettings({ agentMemory: { enabled: Boolean(checked) } })
            }
            aria-label={t("agentMemory.toggle")}
          />
        }
      />
      <SettingsRow
        title={t("agentMemory.userNotes")}
        description={t("agentMemory.userNotesDescription")}
      >
        <div className="mt-3 max-w-2xl pb-3.5">
          <Textarea
            key={memory.userNotes}
            defaultValue={memory.userNotes}
            rows={6}
            disabled={!memory.enabled}
            placeholder={t("agentMemory.userNotesPlaceholder")}
            aria-label={t("agentMemory.userNotes")}
            onBlur={(event) => {
              const userNotes = event.target.value;
              if (userNotes !== memory.userNotes) {
                updateSettings({ agentMemory: { userNotes } });
              }
            }}
          />
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

export function AgentHooksSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const hooksSettings = settings.agentHooks;
  const defaults = DEFAULT_UNIFIED_SETTINGS.agentHooks;

  const replaceHooks = (hooks: ReadonlyArray<AgentHookEntry>) =>
    updateSettings({ agentHooks: { enabled: hooksSettings.enabled, hooks: [...hooks] } });

  return (
    <SettingsSection id="agent-hooks" title={t("agentHooks.title")}>
      <p className="text-xs text-muted-foreground">{t("agentHooks.explanation")}</p>
      <SettingsRow
        title={t("agentHooks.toggle")}
        description={t("agentHooks.toggleDescription")}
        resetAction={
          hooksSettings.enabled !== defaults.enabled || hooksSettings.hooks.length > 0 ? (
            <SettingResetButton
              label={t("agentHooks.toggle")}
              onClick={() =>
                updateSettings({
                  agentHooks: { enabled: defaults.enabled, hooks: [] },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={hooksSettings.enabled}
            onCheckedChange={(checked) =>
              updateSettings({
                agentHooks: { enabled: Boolean(checked), hooks: hooksSettings.hooks },
              })
            }
            aria-label={t("agentHooks.toggle")}
          />
        }
      />
      {hooksSettings.hooks.map((hook, index) => (
        <div
          key={hook.id}
          className="space-y-2 rounded-xl border border-border/60 px-3 py-3 sm:px-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              value={hook.event}
              onValueChange={(value) => {
                const next = hooksSettings.hooks.map((entry, entryIndex) =>
                  entryIndex === index ? { ...entry, event: value as AgentHookEvent } : entry,
                );
                replaceHooks(next);
              }}
            >
              <SelectTrigger className="w-full sm:w-56" aria-label={t("agentHooks.event")}>
                <SelectValue>{t(HOOK_EVENT_LABELS[hook.event])}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="start" alignItemWithTrigger={false}>
                {AGENT_HOOK_EVENTS.map((event) => (
                  <SelectItem key={event} hideIndicator value={event}>
                    {t(HOOK_EVENT_LABELS[event])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <div className="flex items-center gap-2">
              <Switch
                checked={hook.enabled}
                onCheckedChange={(checked) => {
                  const next = hooksSettings.hooks.map((entry, entryIndex) =>
                    entryIndex === index ? { ...entry, enabled: Boolean(checked) } : entry,
                  );
                  replaceHooks(next);
                }}
                aria-label={t("agentHooks.hookEnabled")}
              />
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={t("agentHooks.remove")}
                onClick={() =>
                  replaceHooks(hooksSettings.hooks.filter((_, entryIndex) => entryIndex !== index))
                }
              >
                <Trash2Icon className="size-4" />
              </Button>
            </div>
          </div>
          <Input
            key={`${hook.id}-command`}
            defaultValue={hook.command}
            onBlur={(event) => {
              const command = event.currentTarget.value;
              if (command === hook.command) return;
              const next = hooksSettings.hooks.map((entry, entryIndex) =>
                entryIndex === index ? { ...entry, command } : entry,
              );
              replaceHooks(next);
            }}
            placeholder={t("agentHooks.commandPlaceholder")}
            aria-label={t("agentHooks.command")}
            disabled={!hooksSettings.enabled}
          />
          {(hook.event === "pre_tool_use" || hook.event === "post_tool_use") && (
            <Input
              key={`${hook.id}-matcher`}
              defaultValue={hook.matcher}
              onBlur={(event) => {
                const matcher = event.currentTarget.value;
                if (matcher === hook.matcher) return;
                const next = hooksSettings.hooks.map((entry, entryIndex) =>
                  entryIndex === index ? { ...entry, matcher } : entry,
                );
                replaceHooks(next);
              }}
              placeholder={t("agentHooks.matcherPlaceholder")}
              aria-label={t("agentHooks.matcher")}
              disabled={!hooksSettings.enabled}
            />
          )}
        </div>
      ))}
      <div className="px-3 sm:px-4">
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            replaceHooks([
              ...hooksSettings.hooks,
              {
                id: randomUUID(),
                enabled: true,
                event: "user_prompt_submit",
                command: "",
                matcher: "",
              },
            ])
          }
        >
          <PlusIcon />
          {t("agentHooks.add")}
        </Button>
      </div>
    </SettingsSection>
  );
}

export function WebSearchSettingsSection() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const search = settings.webSearch;
  const defaults = DEFAULT_UNIFIED_SETTINGS.webSearch;
  const needsKey = search.engine === "tavily" || search.engine === "brave";
  const needsUrl = search.engine === "searxng";

  return (
    <SettingsSection id="web-search" title={t("webSearch.title")}>
      <p className="text-xs text-muted-foreground">{t("webSearch.explanation")}</p>
      <SettingsRow
        title={t("webSearch.toggle")}
        description={t("webSearch.toggleDescription")}
        resetAction={
          search.enabled !== defaults.enabled || search.engine !== defaults.engine ? (
            <SettingResetButton
              label={t("webSearch.toggle")}
              onClick={() =>
                updateSettings({
                  webSearch: {
                    enabled: defaults.enabled,
                    engine: defaults.engine,
                    baseUrl: defaults.baseUrl,
                  },
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={search.enabled}
            onCheckedChange={(checked) =>
              updateSettings({ webSearch: { enabled: Boolean(checked) } })
            }
            aria-label={t("webSearch.toggle")}
          />
        }
      />
      <SettingsRow
        title={t("webSearch.engine")}
        description={t("webSearch.engineDescription")}
        control={
          <Select
            value={search.engine}
            onValueChange={(value) =>
              updateSettings({ webSearch: { engine: value as WebSearchEngine } })
            }
          >
            <SelectTrigger className="w-full sm:w-56" aria-label={t("webSearch.engine")}>
              <SelectValue>{t(ENGINE_LABELS[search.engine])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {WEB_SEARCH_ENGINES.map((engine) => (
                <SelectItem key={engine} hideIndicator value={engine}>
                  {t(ENGINE_LABELS[engine])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {needsUrl ? (
        <SettingsRow title={t("webSearch.baseUrl")} description={t("webSearch.baseUrlDescription")}>
          <div className="mt-3 max-w-2xl pb-3.5">
            <Input
              key={search.baseUrl}
              defaultValue={search.baseUrl}
              placeholder="https://searx.example"
              aria-label={t("webSearch.baseUrl")}
              onBlur={(event) => {
                const baseUrl = event.currentTarget.value.trim();
                if (baseUrl !== search.baseUrl) updateSettings({ webSearch: { baseUrl } });
              }}
            />
          </div>
        </SettingsRow>
      ) : null}
      {needsKey ? (
        <SettingsRow title={t("webSearch.apiKey")} description={t("webSearch.apiKeyDescription")}>
          <div className="mt-3 flex max-w-2xl items-center gap-2 pb-3.5">
            <Input
              type="password"
              autoComplete="off"
              placeholder={
                search.apiKeyRedacted === true
                  ? t("webSearch.apiKeyStored")
                  : t("webSearch.apiKeyPlaceholder")
              }
              aria-label={t("webSearch.apiKey")}
              onBlur={(event) => {
                const apiKey = event.currentTarget.value.trim();
                if (apiKey.length > 0) updateSettings({ webSearch: { apiKey } });
                event.currentTarget.value = "";
              }}
            />
            {search.apiKeyRedacted === true ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => updateSettings({ webSearch: { apiKey: "", apiKeyRedacted: false } })}
              >
                {t("webSearch.apiKeyRemove")}
              </Button>
            ) : null}
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
