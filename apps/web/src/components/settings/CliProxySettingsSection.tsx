import {
  ActivityIcon,
  ArrowDownAZIcon,
  CalendarDaysIcon,
  CheckIcon,
  ChevronDownIcon,
  EyeIcon,
  FileJsonIcon,
  FolderOpenIcon,
  Grid2X2Icon,
  KeyRoundIcon,
  Link2Icon,
  ListIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Settings2Icon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Trash2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AuthTerminalOperateScope,
  ProviderInstanceId,
  type CliProxyRequest,
  type CliProxyResult,
  type EnvironmentId,
  type LocalAccountSummary,
} from "@codework/contracts";

import { squashAtomCommandFailure } from "@codework/client-runtime/state/runtime";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePrimarySessionState } from "../../environments/primary";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { cn } from "~/lib/utils";
import { t } from "~/i18n";

type LocalProvider = "codex" | "claude" | "xai" | "cursor";
type ViewMode = "grid" | "list";

export const localAccountIdFromFileName = (name: string): string => {
  const stem = name.replace(/\.(json|JSON)$/u, "").trim();
  const normalized = stem
    .replace(/[^A-Za-z0-9_-]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, 96);
  return /^[A-Za-z]/u.test(normalized) ? normalized : `account-${normalized || "import"}`;
};

const localProviderInstanceId = (provider: LocalProvider): ProviderInstanceId =>
  ProviderInstanceId.make(
    provider === "claude" ? "claudeAgent" : provider === "xai" ? "grok" : provider,
  );

const providerNames: Record<LocalProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  xai: "Grok",
  cursor: "Cursor",
};

function providerName(provider: LocalAccountSummary["provider"]): string {
  return providerNames[provider];
}

function authName(authKind: LocalAccountSummary["authKind"]): string {
  return authKind === "oauth"
    ? "OAuth"
    : authKind === "api-key"
      ? "API Key"
      : t("cliProxy.authUnlabeled");
}

function accountMatches(account: LocalAccountSummary, query: string): boolean {
  if (!query.trim()) return true;
  const needle = query.trim().toLocaleLowerCase();
  return [account.id, account.displayName, account.provider, ...account.models].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

/** 账号卡只展示 LocalAccountSummary 的真实字段；凭据和额度永远不从客户端猜测。 */
export function CliProxySettingsSection({
  environmentId,
  readOnly: providerReadOnly,
  onConnected,
}: {
  environmentId: EnvironmentId;
  readOnly: boolean;
  onConnected: (instanceId: ProviderInstanceId) => void;
}) {
  // 主环境使用主会话状态；远程环境才走 EnvironmentSupervisor 会话。
  // 深链带 environmentId 时不能把主环境误判成未连接的远程环境。
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environmentSession = useEnvironmentSessionState(environmentId);
  const primarySession = usePrimarySessionState();
  const session = environmentId === primaryEnvironmentId ? primarySession : environmentSession;
  const readOnly =
    providerReadOnly ||
    session.data?.authenticated !== true ||
    session.data?.scopes?.includes(AuthTerminalOperateScope) !== true;
  const command = useAtomCommand(serverEnvironment.cliProxy, { reportFailure: false });
  const [status, setStatus] = useState<CliProxyResult | null>(null);
  const [strategy, setStrategy] = useState<"round-robin" | "fill-first">("round-robin");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [deleteName, setDeleteName] = useState<string | null>(null);
  const [deleteLocalId, setDeleteLocalId] = useState<string | null>(null);
  const [importName, setImportName] = useState("");
  const [importContent, setImportContent] = useState("");
  const [instanceId, setInstanceId] = useState("cpa");
  const [displayName, setDisplayName] = useState("CPA");
  const [localProvider, setLocalProvider] = useState<LocalProvider>("codex");
  const [localId, setLocalId] = useState("");
  const [localDisplayName, setLocalDisplayName] = useState("");
  const [localContent, setLocalContent] = useState("");
  const [localInstanceId, setLocalInstanceId] = useState("");
  const [localModels, setLocalModels] = useState("");
  const [localApiKey, setLocalApiKey] = useState("");
  const [localStrategy, setLocalStrategy] = useState<"round-robin" | "fill-first">("round-robin");
  const [externalKeyName, setExternalKeyName] = useState("");
  const [issuedExternalKey, setIssuedExternalKey] = useState("");
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<"all" | LocalProvider>("all");
  const [authFilter, setAuthFilter] = useState<"all" | "oauth" | "api-key">("all");
  const [sortBy, setSortBy] = useState<"name" | "provider" | "enabled">("name");
  const [viewMode, setViewMode] = useState<ViewMode>("grid");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showImport, setShowImport] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const localFileInputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(
    async (input: CliProxyRequest) => {
      if (lock.current || readOnly) return;
      lock.current = true;
      setBusy(true);
      setFeedback(null);
      try {
        const result = await command({ environmentId, input });
        if (result._tag !== "Success") {
          const failure = squashAtomCommandFailure(result);
          throw failure instanceof Error ? failure : new Error(t("cliProxy.failed"));
        }
        setStatus(result.value);
        if (input.action === "status" || input.action === "configure") {
          setStrategy(result.value.config.strategy);
        }
        if (input.action === "importAccount") {
          setImportContent("");
          setImportName("");
        }
        if (input.action === "importLocalAccount") {
          setLocalContent("");
          setLocalApiKey("");
        }
        if (result.value.localStrategy) setLocalStrategy(result.value.localStrategy);
        setIssuedExternalKey(result.value.externalGateway?.issuedKey ?? "");
        if (input.action === "deleteAccount") setDeleteName(null);
        if (input.action === "deleteLocalAccount") setDeleteLocalId(null);
        if (input.action === "setLocalAccountsEnabled") setSelectedIds(new Set());
        if (result.value.connectedInstanceId) setInstanceId(result.value.connectedInstanceId);
        setFeedback({ error: false, text: t("cliProxy.done") });
      } catch (error) {
        setFeedback({
          error: true,
          text: error instanceof Error ? error.message : t("cliProxy.failed"),
        });
      } finally {
        lock.current = false;
        setBusy(false);
      }
    },
    [command, environmentId, readOnly],
  );

  useEffect(() => {
    void run({ action: "status" });
  }, [run]);

  const disabled = busy || readOnly;
  const unavailable = disabled || !status?.running;
  const accounts = status?.localAccounts ?? [];
  const filteredAccounts = accounts
    .filter((account) => accountMatches(account, query))
    .filter((account) => providerFilter === "all" || account.provider === providerFilter)
    .filter((account) => authFilter === "all" || account.authKind === authFilter)
    .sort((left, right) => {
      if (sortBy === "enabled" && left.enabled !== right.enabled) return left.enabled ? -1 : 1;
      const leftValue = sortBy === "provider" ? left.provider : left.displayName;
      const rightValue = sortBy === "provider" ? right.provider : right.displayName;
      return leftValue.localeCompare(rightValue);
    });
  const allVisibleSelected =
    filteredAccounts.length > 0 && filteredAccounts.every((account) => selectedIds.has(account.id));
  const enabledCount = accounts.filter((account) => account.enabled).length;

  const toggleSelected = (id: string, checked: boolean | "indeterminate") => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked === true) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const selectVisible = (checked: boolean | "indeterminate") => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked === true) filteredAccounts.forEach((account) => next.add(account.id));
      else filteredAccounts.forEach((account) => next.delete(account.id));
      return next;
    });
  };

  const configure = () => void run({ action: "configure", config: { strategy } });
  const autoConnect = () =>
    void run({
      action: "connectByok",
      instanceId: ProviderInstanceId.make(status?.connectedInstanceId ?? "cpa"),
      displayName: displayName.trim() || t("cliProxy.poolDefaultName"),
    });
  const importLocal = () => {
    let content = localApiKey.trim()
      ? JSON.stringify({
          api_key: localApiKey.trim(),
          models: localModels
            .split(",")
            .map((model) => model.trim())
            .filter(Boolean),
        })
      : localContent;
    try {
      const value = JSON.parse(content) as Record<string, unknown>;
      const models = localModels
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean);
      if (models.length > 0) value.models = models;
      content = JSON.stringify(value);
    } catch {
      // 服务端会返回格式错误；这里不把用户输入写入日志。
    }
    void run({
      action: "importLocalAccount",
      id: localId.trim(),
      provider: localProvider,
      displayName: localDisplayName.trim(),
      content,
    });
  };

  const chooseLocalFile = () => {
    setShowImport(true);
    localFileInputRef.current?.click();
  };

  const readLocalFile = async (file: File) => {
    const content = await file.text();
    setLocalContent(content);
    setLocalId((current) => current || localAccountIdFromFileName(file.name));
    const stem = file.name.replace(/\.(json|JSON)$/u, "").trim();
    setLocalDisplayName((current) => current || stem);
    try {
      const value = JSON.parse(content) as Record<string, unknown>;
      const provider = String(value.provider ?? value.type ?? "").toLowerCase();
      if (provider.includes("claude") || provider.includes("anthropic") || value.claudeAiOauth) {
        setLocalProvider("claude");
      } else if (
        provider.includes("grok") ||
        provider.includes("xai") ||
        Object.keys(value).some((key) => key.includes("x.ai"))
      ) {
        setLocalProvider("xai");
      } else if (provider.includes("cursor")) {
        setLocalProvider("cursor");
      } else {
        setLocalProvider("codex");
      }
      if (Array.isArray(value.models)) {
        setLocalModels(
          value.models.filter((model): model is string => typeof model === "string").join(", "),
        );
      }
    } catch {
      // 服务端会返回格式错误；不把凭据内容写入日志。
    }
  };

  return (
    <section
      className="min-w-0 space-y-4 rounded-2xl bg-muted/15 p-3 sm:space-y-5 sm:p-5"
      aria-label={t("cliProxy.title")}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
            <SparklesIcon className="size-5" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{t("cliProxy.title")}</h1>
            <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground sm:text-sm">
              {t("cliProxy.description")}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            disabled={
              disabled ||
              accounts.every(
                (account) =>
                  !account.enabled || account.provider === "cursor" || account.models.length === 0,
              ) ||
              status?.connectedInstanceId !== undefined
            }
            onClick={autoConnect}
          >
            <Link2Icon />
            {status?.connectedInstanceId ? t("cliProxy.autoConnected") : t("cliProxy.autoConnect")}
          </Button>
          <Badge variant={status?.running ? "success" : "warning"} size="sm">
            <ActivityIcon />
            {status?.running ? t("cliProxy.embeddedRunning") : t("cliProxy.unknown")}
          </Badge>
          <Button
            size="sm"
            variant="outline"
            aria-label={t("cliProxy.refresh")}
            disabled={disabled}
            onClick={() => void run({ action: "status" })}
          >
            {t("cliProxy.refresh")}
          </Button>
        </div>
      </div>

      {status?.running ? (
        <Alert
          variant="success"
          className="border-border/60 bg-muted/30"
          controlAlignment="first-line"
        >
          <ShieldCheckIcon />
          <AlertTitle>
            {accounts.length > 0 ? t("cliProxy.embeddedConnected") : t("cliProxy.embeddedStarted")}
          </AlertTitle>
          <AlertDescription>
            <span className="break-all">
              {t("cliProxy.gatewayForwardHint", { url: status.baseUrl })}
            </span>
          </AlertDescription>
        </Alert>
      ) : null}

      {readOnly ? <p className="text-xs text-muted-foreground">{t("cliProxy.noAccess")}</p> : null}

      <div className="rounded-xl border border-border/60 bg-background/60 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">{t("cliProxy.officialLoginTitle")}</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {t("cliProxy.officialLoginHint")}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onConnected(localProviderInstanceId("codex"))}
          >
            {t("cliProxy.openOfficialLogin")}
          </Button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              ["Codex", t("cliProxy.supportCodex"), true],
              ["Claude", t("cliProxy.supportClaude"), true],
              ["Grok / xAI", t("cliProxy.supportGrok"), true],
              ["Kimi", t("cliProxy.supportKimi"), true],
              ["Antigravity", t("cliProxy.supportAntigravity"), true],
            ] as const
          ).map(([name, detail, supported]) => (
            <div
              key={name}
              className="rounded-lg border border-border/60 bg-background/70 px-2.5 py-2"
            >
              <div className="flex items-center gap-1.5 text-xs font-medium">
                <span
                  className={cn(
                    "size-1.5 rounded-full",
                    supported ? "bg-success" : "bg-muted-foreground/50",
                  )}
                />
                {name}
              </div>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-card p-3 shadow-sm sm:p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 basis-full sm:min-w-[12rem] sm:flex-1">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              aria-label={t("cliProxy.searchAccounts")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("cliProxy.searchAccountsPlaceholder")}
              className="pl-9"
            />
          </div>
          <div className="flex items-center rounded-lg border border-input bg-background p-0.5">
            <Button
              size="icon-sm"
              variant={viewMode === "list" ? "default" : "ghost"}
              aria-label={t("cliProxy.listView")}
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              <ListIcon />
            </Button>
            <Button
              size="icon-sm"
              variant={viewMode === "grid" ? "default" : "ghost"}
              aria-label={t("cliProxy.gridView")}
              aria-pressed={viewMode === "grid"}
              onClick={() => setViewMode("grid")}
            >
              <Grid2X2Icon />
            </Button>
          </div>
          <label className="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background px-2 text-xs font-medium">
            <SlidersHorizontalIcon className="size-3.5 text-muted-foreground" />
            <span className="sr-only">{t("cliProxy.platformFilter")}</span>
            <select
              className="max-w-[8rem] bg-transparent outline-none"
              aria-label={t("cliProxy.platformFilter")}
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.target.value as "all" | LocalProvider)}
            >
              <option value="all">{t("cliProxy.allPlatforms", { count: accounts.length })}</option>
              {(Object.keys(providerNames) as LocalProvider[]).map((provider) => (
                <option key={provider} value={provider}>
                  {providerName(provider)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background px-2 text-xs font-medium">
            <KeyRoundIcon className="size-3.5 text-muted-foreground" />
            <span className="sr-only">{t("cliProxy.authFilter")}</span>
            <select
              className="max-w-[8rem] bg-transparent outline-none"
              aria-label={t("cliProxy.authFilter")}
              value={authFilter}
              onChange={(event) => setAuthFilter(event.target.value as typeof authFilter)}
            >
              <option value="all">{t("cliProxy.allAuth")}</option>
              <option value="oauth">OAuth</option>
              <option value="api-key">API Key</option>
            </select>
          </label>
          <label className="flex h-8 items-center gap-1.5 rounded-lg border border-input bg-background px-2 text-xs font-medium">
            <ArrowDownAZIcon className="size-3.5 text-muted-foreground" />
            <span className="sr-only">{t("cliProxy.sort")}</span>
            <select
              className="max-w-[8rem] bg-transparent outline-none"
              aria-label={t("cliProxy.sort")}
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as typeof sortBy)}
            >
              <option value="name">{t("cliProxy.sortByName")}</option>
              <option value="provider">{t("cliProxy.sortByPlatform")}</option>
              <option value="enabled">{t("cliProxy.sortByEnabled")}</option>
            </select>
          </label>
          <div className="ml-auto flex items-center gap-1">
            <Button
              size="sm"
              variant="default"
              aria-label={t("localAccountPool.import")}
              aria-expanded={showImport}
              disabled={readOnly}
              onClick={() => setShowImport((current) => !current)}
            >
              <PlusIcon />
              {t("localAccountPool.import")}
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={t("cliProxy.refreshAccounts")}
              disabled={disabled}
              onClick={() => void run({ action: "localAccounts" })}
            >
              <RefreshCwIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={t("cliProxy.viewGuide")}
              onClick={() => setShowAdvanced(true)}
            >
              <EyeIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={t("localAccountPool.chooseFile")}
              disabled={disabled}
              onClick={chooseLocalFile}
            >
              <UploadIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label={t("cliProxy.openAdvanced")}
              onClick={() => setShowAdvanced(true)}
            >
              <Settings2Icon />
            </Button>
          </div>
        </div>
        <input
          ref={localFileInputRef}
          className="hidden"
          id="local-account-file"
          type="file"
          accept="application/json,.json"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void readLocalFile(file);
            event.currentTarget.value = "";
          }}
        />
        {showImport ? (
          <div className="mt-3 rounded-xl border border-border/60 bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">{t("cliProxy.importLocalTitle")}</h2>
                <p className="text-xs text-muted-foreground">{t("cliProxy.importLocalHint")}</p>
              </div>
              <Button
                size="icon-micro"
                variant="ghost"
                aria-label={t("cliProxy.closeImport")}
                onClick={() => setShowImport(false)}
              >
                <XIcon />
              </Button>
            </div>
            <div className="mb-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-semibold">{t("cliProxy.oauthSection")}</h3>
                  <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                    {t("cliProxy.oauthSectionHint")}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => onConnected(localProviderInstanceId(localProvider))}
                >
                  <KeyRoundIcon />
                  {t("cliProxy.openProviderLogin", { provider: providerName(localProvider) })}
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("localAccountPool.provider")}</span>
                <select
                  className="h-8 rounded-md border border-input bg-background px-2"
                  value={localProvider}
                  disabled={disabled}
                  onChange={(event) => setLocalProvider(event.target.value as LocalProvider)}
                >
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                  <option value="xai">Grok</option>
                  <option value="cursor">Cursor</option>
                </select>
              </label>
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("localAccountPool.id")}</span>
                <Input
                  size="sm"
                  value={localId}
                  disabled={disabled}
                  onChange={(event) => setLocalId(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("localAccountPool.displayName")}</span>
                <Input
                  size="sm"
                  value={localDisplayName}
                  disabled={disabled}
                  onChange={(event) => setLocalDisplayName(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("localAccountPool.models")}</span>
                <Input
                  size="sm"
                  value={localModels}
                  disabled={disabled}
                  onChange={(event) => setLocalModels(event.target.value)}
                  placeholder="gpt-5, claude-…"
                />
              </label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label
                htmlFor="local-account-file"
                className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-2.5 text-xs font-medium"
              >
                <FolderOpenIcon className="size-3.5" />
                {t("localAccountPool.chooseFile")}
              </label>
              <Input
                size="sm"
                type="password"
                autoComplete="new-password"
                value={localContent}
                disabled={disabled}
                onChange={(event) => setLocalContent(event.target.value)}
                placeholder='{"access_token":"…"}'
                className="min-w-[14rem] flex-1"
              />
              <Input
                size="sm"
                type="password"
                autoComplete="new-password"
                value={localApiKey}
                disabled={disabled}
                onChange={(event) => setLocalApiKey(event.target.value)}
                placeholder={t("cliProxy.apiKeyPlaceholder")}
                className="min-w-[14rem] flex-1"
              />
              <Button
                size="sm"
                disabled={
                  disabled ||
                  !localId.trim() ||
                  !localDisplayName.trim() ||
                  (!localContent.trim() && !localApiKey.trim())
                }
                onClick={importLocal}
              >
                <UploadIcon />
                {t("localAccountPool.import")}
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-background/70 px-3 py-3 sm:px-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox
            checked={allVisibleSelected}
            onCheckedChange={selectVisible}
            aria-label={t("cliProxy.selectAllAccounts")}
          />
          {t("cliProxy.selectAll")}
          <span className="text-xs font-normal text-muted-foreground">
            {t("cliProxy.accountCounts", { total: filteredAccounts.length, enabled: enabledCount })}
          </span>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-7 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs">
            <span className="text-muted-foreground">{t("cliProxy.schedulingLabel")}</span>
            <select
              className="bg-transparent font-medium outline-none"
              value={localStrategy}
              disabled={disabled}
              onChange={(event) => {
                const next = event.target.value === "fill-first" ? "fill-first" : "round-robin";
                setLocalStrategy(next);
                void run({ action: "setLocalAccountPoolStrategy", strategy: next });
              }}
            >
              <option value="round-robin">{t("cliProxy.roundRobin")}</option>
              <option value="fill-first">{t("cliProxy.fillFirst")}</option>
            </select>
          </label>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={() => void run({ action: "localAccounts" })}
          >
            {t("cliProxy.refreshAccounts")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || selectedIds.size === 0}
            onClick={() =>
              void run({
                action: "setLocalAccountsEnabled",
                ids: [...selectedIds],
                enabled: true,
              })
            }
          >
            <CheckIcon />
            {t("cliProxy.enableSelected", { count: selectedIds.size })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || selectedIds.size === 0}
            onClick={() =>
              void run({
                action: "setLocalAccountsEnabled",
                ids: [...selectedIds],
                enabled: false,
              })
            }
          >
            {t("cliProxy.disableSelected")}
          </Button>
        </div>
      </div>

      {filteredAccounts.length > 0 ? (
        <div className={cn(viewMode === "grid" ? "grid gap-4 md:grid-cols-2" : "space-y-3")}>
          {filteredAccounts.map((account) => {
            const selected = selectedIds.has(account.id);
            return (
              <article
                key={account.id}
                className={cn(
                  "min-w-0 rounded-2xl border bg-card p-4 shadow-sm sm:p-5",
                  selected ? "border-primary ring-2 ring-primary/15" : "border-border/70",
                  viewMode === "list" &&
                    "grid gap-4 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,1.4fr)_auto] lg:items-center",
                )}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <Checkbox
                    checked={selected}
                    onCheckedChange={(checked) => toggleSelected(account.id, checked)}
                    aria-label={t("cliProxy.selectAccount", { name: account.displayName })}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h2 className="min-w-0 truncate text-sm font-semibold">
                        {account.displayName}
                      </h2>
                      <Badge size="sm" variant={account.enabled ? "success" : "secondary"}>
                        {account.enabled ? t("cliProxy.enabled") : t("cliProxy.disabled")}
                      </Badge>
                      <Badge size="sm" variant="outline">
                        {providerName(account.provider)}
                      </Badge>
                    </div>
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {t("cliProxy.localAccountId", { id: account.id })}
                    </p>
                  </div>
                </div>

                <div className={cn("mt-4 space-y-3", viewMode === "list" && "lg:mt-0")}>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <KeyRoundIcon className="size-3.5" />
                      {t("cliProxy.authMethodLabel")}
                    </span>
                    <span className="font-medium">{authName(account.authKind)}</span>
                  </div>
                  <div className="rounded-xl bg-muted/35 p-3">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5 font-medium">
                        <FileJsonIcon className="size-3.5 text-muted-foreground" />
                        {t("cliProxy.availableModels")}
                      </span>
                      <span className="text-muted-foreground">
                        {t("cliProxy.modelsDeclared", { count: account.models.length })}
                      </span>
                    </div>
                    {account.models.length > 0 ? (
                      <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                        {account.models.map((model) => (
                          <div
                            key={model}
                            className="flex min-w-0 items-center gap-1.5 rounded-md border border-border/60 bg-background/70 px-2 py-1 text-xs"
                          >
                            <span className="size-1.5 shrink-0 rounded-full bg-success" />
                            <span className="truncate">{model}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("cliProxy.noModelsHint")}
                      </p>
                    )}
                  </div>
                  <div className="flex items-start gap-2 rounded-xl border border-dashed border-border/80 px-3 py-2.5 text-xs">
                    <CalendarDaysIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0">
                      <p className="font-medium">{t("cliProxy.usageTitle")}</p>
                      <p className="mt-0.5 text-muted-foreground">{t("cliProxy.usageHint")}</p>
                    </div>
                  </div>
                </div>

                <div
                  className={cn(
                    "mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3",
                    viewMode === "list" && "lg:col-span-full lg:mt-0",
                  )}
                >
                  <span className="text-xs text-muted-foreground">
                    {t("cliProxy.accountActions")}
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t("cliProxy.refreshAccounts")}
                      disabled={disabled}
                      onClick={() => void run({ action: "localAccounts" })}
                    >
                      <RefreshCwIcon />
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={disabled}
                      onClick={() =>
                        void run({
                          action: "setLocalAccountEnabled",
                          id: account.id,
                          enabled: !account.enabled,
                        })
                      }
                    >
                      {account.enabled ? t("cliProxy.disable") : t("cliProxy.enable")}
                    </Button>
                    {deleteLocalId === account.id ? (
                      <>
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={disabled}
                          onClick={() => void run({ action: "deleteLocalAccount", id: account.id })}
                        >
                          {t("cliProxy.confirmDelete")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => setDeleteLocalId(null)}
                        >
                          {t("cancel")}
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={t("delete")}
                        disabled={disabled}
                        onClick={() => setDeleteLocalId(account.id)}
                      >
                        <Trash2Icon />
                      </Button>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-border bg-card px-4 py-10 text-center sm:px-6">
          <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground">
            <FolderOpenIcon className="size-6" />
          </div>
          <h2 className="mt-3 text-sm font-semibold">
            {accounts.length > 0 ? t("cliProxy.noMatchingAccounts") : t("cliProxy.noAccounts")}
          </h2>
          <p className="mx-auto mt-1 max-w-md text-xs leading-5 text-muted-foreground">
            {accounts.length > 0
              ? t("cliProxy.noMatchingAccountsHint")
              : t("cliProxy.importedAccountHint")}
          </p>
          {accounts.length === 0 ? (
            <Button
              size="sm"
              className="mt-4"
              disabled={readOnly}
              onClick={() => setShowImport(true)}
            >
              <PlusIcon />
              {t("localAccountPool.import")}
            </Button>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
        <span>
          {t("cliProxy.showingAccounts", {
            shown: filteredAccounts.length,
            total: accounts.length,
          })}
        </span>
        <span className="flex items-center gap-1.5">
          <Link2Icon className="size-3.5" />
          {t("cliProxy.sharedRouteAdvancedHint")}
        </span>
      </div>

      <details
        open={showAdvanced}
        onToggle={(event) => setShowAdvanced(event.currentTarget.open)}
        className="group rounded-xl border border-border/60 bg-background/70"
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2">
            <Settings2Icon className="size-4 text-muted-foreground" />
            {t("cliProxy.advancedTitle")}
          </span>
          <ChevronDownIcon className="size-4 text-muted-foreground group-open:rotate-180" />
        </summary>
        <div className="space-y-4 border-t border-border/70 px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1.5 text-xs font-medium">
              <span>{t("cliProxy.strategy")}</span>
              <select
                className="h-8 rounded-md border border-input bg-background px-2"
                value={strategy}
                disabled={disabled}
                onChange={(event) =>
                  setStrategy(event.target.value === "fill-first" ? "fill-first" : "round-robin")
                }
              >
                <option value="round-robin">{t("cliProxy.roundRobin")}</option>
                <option value="fill-first">{t("cliProxy.fillFirst")}</option>
              </select>
            </label>
            <div className="flex items-end gap-2">
              <Button
                size="sm"
                disabled={disabled || strategy === status?.config.strategy}
                onClick={configure}
              >
                {t("cliProxy.saveConfig")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                onClick={() => void run({ action: "status" })}
              >
                {t("cliProxy.refresh")}
              </Button>
            </div>
          </div>

          <div className="grid gap-3 border-t border-border/70 pt-4">
            <div>
              <h2 className="text-sm font-semibold">{t("cliProxy.bindSharedRouteTitle")}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{t("cliProxy.connectHint")}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
              <Input
                size="sm"
                disabled={unavailable || !!status?.connectedInstanceId}
                value={instanceId}
                maxLength={64}
                onChange={(event) => setInstanceId(event.target.value)}
                placeholder={t("localAccountPool.instancePlaceholder")}
              />
              <Input
                size="sm"
                disabled={unavailable}
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder={t("cliProxy.displayName")}
              />
              <Button
                size="sm"
                disabled={
                  unavailable ||
                  !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(instanceId) ||
                  !displayName.trim()
                }
                onClick={() =>
                  void run({
                    action: "connectByok",
                    instanceId: ProviderInstanceId.make(instanceId),
                    displayName: displayName.trim(),
                  })
                }
              >
                <Link2Icon />
                {t("cliProxy.connect")}
              </Button>
            </div>
            {status?.connectedInstanceId ? (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{t("cliProxy.connected", { id: status.connectedInstanceId })}</span>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => onConnected(status.connectedInstanceId!)}
                >
                  {t("cliProxy.editRoute")}
                </Button>
              </div>
            ) : null}
          </div>

          <div className="grid gap-3 border-t border-border/70 pt-4">
            <div>
              <h2 className="text-sm font-semibold">{t("localAccountPool.externalTitle")}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("localAccountPool.externalDescription")}
              </p>
            </div>
            {status?.externalGateway ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="grid gap-1 text-xs font-medium">
                  <span>{t("localAccountPool.externalOpenai")}</span>
                  <Input
                    size="sm"
                    readOnly
                    value={status.externalGateway.openaiBaseUrl}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
                <label className="grid gap-1 text-xs font-medium">
                  <span>{t("localAccountPool.externalAnthropic")}</span>
                  <Input
                    size="sm"
                    readOnly
                    value={status.externalGateway.anthropicBaseUrl}
                    onFocus={(event) => event.target.select()}
                  />
                </label>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Input
                size="sm"
                className="min-w-[12rem] flex-1"
                value={externalKeyName}
                disabled={disabled}
                onChange={(event) => setExternalKeyName(event.target.value)}
                placeholder={t("localAccountPool.externalName")}
              />
              <Button
                size="sm"
                disabled={disabled || !externalKeyName.trim()}
                onClick={() =>
                  void run({ action: "createExternalGatewayKey", name: externalKeyName.trim() })
                }
              >
                {t("localAccountPool.externalCreate")}
              </Button>
            </div>
            {issuedExternalKey ? (
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("localAccountPool.externalKey")}</span>
                <Input
                  size="sm"
                  type="password"
                  readOnly
                  value={issuedExternalKey}
                  onFocus={(event) => event.target.select()}
                />
              </label>
            ) : null}
            {status?.externalGateway?.keys.length ? (
              status.externalGateway.keys.map((key) => (
                <div
                  key={key.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 p-2 text-xs"
                >
                  <span>{key.name}</span>
                  <div className="flex gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => void run({ action: "rotateExternalGatewayKey", id: key.id })}
                    >
                      {t("localAccountPool.externalRotate")}
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={disabled}
                      onClick={() => void run({ action: "revokeExternalGatewayKey", id: key.id })}
                    >
                      {t("localAccountPool.externalRevoke")}
                    </Button>
                  </div>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">{t("localAccountPool.externalEmpty")}</p>
            )}
          </div>

          <details className="border-t border-border/70 pt-4">
            <summary className="cursor-pointer text-sm font-semibold">
              {t("cliProxy.import")}
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("cliProxy.importName")}</span>
                <Input
                  size="sm"
                  value={importName}
                  disabled={unavailable}
                  onChange={(event) => setImportName(event.target.value)}
                  placeholder="account.json"
                />
              </label>
              <label className="grid gap-1 text-xs font-medium">
                <span>{t("cliProxy.importContent")}</span>
                <Input
                  size="sm"
                  type="password"
                  autoComplete="new-password"
                  value={importContent}
                  maxLength={1048576}
                  disabled={unavailable}
                  onChange={(event) => setImportContent(event.target.value)}
                />
              </label>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("cliProxy.importHint")}</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                disabled={unavailable || !importName.trim() || !importContent.trim()}
                onClick={() =>
                  void run({
                    action: "importAccount",
                    name: importName.trim(),
                    content: importContent,
                  })
                }
              >
                {t("cliProxy.import")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setImportContent("");
                  setImportName("");
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </details>

          <div className="border-t border-border/70 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">{t("cliProxy.compatibleAccountsTitle")}</h2>
              <Button
                size="xs"
                variant="outline"
                disabled={unavailable}
                onClick={() => void run({ action: "accounts" })}
              >
                {t("cliProxy.refreshAccounts")}
              </Button>
            </div>
            {status?.accounts.length ? (
              <div className="mt-2 space-y-2">
                {status.accounts.map((account) => (
                  <div
                    key={account.name}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/70 p-2 text-xs"
                  >
                    <span className="break-all">
                      {account.name} · {account.provider} ·{" "}
                      {account.disabled ? t("cliProxy.disabled") : account.status}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={unavailable}
                        onClick={() =>
                          void run({
                            action: "setAccountEnabled",
                            name: account.name,
                            enabled: account.disabled,
                          })
                        }
                      >
                        {t(account.disabled ? "cliProxy.enable" : "cliProxy.disable")}
                      </Button>
                      {deleteName === account.name ? (
                        <>
                          <Button
                            size="xs"
                            variant="destructive"
                            disabled={unavailable}
                            onClick={() =>
                              void run({ action: "deleteAccount", name: account.name })
                            }
                          >
                            {t("cliProxy.confirmDelete")}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setDeleteName(null)}
                          >
                            {t("cancel")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          aria-label={t("delete")}
                          disabled={unavailable}
                          onClick={() => setDeleteName(account.name)}
                        >
                          <Trash2Icon />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{t("cliProxy.noAccounts")}</p>
            )}
          </div>

          <div className="grid gap-2 border-t border-border/70 pt-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              size="sm"
              value={localInstanceId}
              disabled={disabled}
              onChange={(event) => setLocalInstanceId(event.target.value)}
              placeholder={t("localAccountPool.instancePlaceholder")}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !localInstanceId.trim()}
              onClick={() =>
                void run({
                  action: "publishLocalAccountPool",
                  instanceId: ProviderInstanceId.make(localInstanceId.trim()),
                  provider: localProvider,
                })
              }
            >
              <Link2Icon />
              {t("localAccountPool.bind")}
            </Button>
          </div>
        </div>
      </details>

      {feedback ? (
        <p
          role={feedback.error ? "alert" : "status"}
          className={cn(
            "px-1 text-xs",
            feedback.error ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {feedback.text}
        </p>
      ) : null}
    </section>
  );
}
