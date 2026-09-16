import { Plus, X } from "lucide-react";
import type { EnvironmentId, SshServerId, ThreadId } from "@codework/contracts";
import {
  EMPTY_SSH_TERMINAL_BUFFER_STATE,
  type SshTerminalBufferState,
} from "@codework/client-runtime/state/ssh-terminal";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import {
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  LEGACY_TYPOGRAPHY_ADVANCED_STORAGE_KEY,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../appearanceFonts";
import { useClientSettings } from "../hooks/useSettings";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useEnvironmentQuery } from "../state/query";
import { sshTerminalEnvironment } from "../state/ssh";
import { useAtomCommand } from "../state/use-atom-command";
import { cn } from "~/lib/utils";
import { t } from "~/i18n";
import { terminalThemeFromApp } from "./ThreadTerminalDrawer";
import { DEFAULT_TERMINAL_FONT_SIZE, GhosttyTerminalSurface } from "~/terminal/ghostty/surface";

function writeSystemMessage(terminal: GhosttyTerminalSurface, message: string): void {
  terminal.write(`\r\n[ssh] ${message}\r\n`);
}

function useSshTerminalFont() {
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
    { legacyKey: LEGACY_TYPOGRAPHY_ADVANCED_STORAGE_KEY },
  );
  const family = useClientSettings((settings) =>
    resolveTerminalFontPreference({
      advanced: advancedTypography,
      code: settings.fontFamilyCode,
      terminal: settings.fontFamilyTerminal,
    }),
  );
  const size = useClientSettings((settings) =>
    resolveTerminalFontSizePreference({
      advanced: advancedTypography,
      code: settings.fontSizeCode,
      terminal: settings.fontSizeTerminal,
    }),
  );
  return { family, size };
}

interface SshTerminalViewportProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  serverId: SshServerId;
  terminalId: string;
}

/**
 * 单个 SSH shell 通道的视口。挂载即 open（服务端「确保在跑」语义：活会话
 * 复用 scrollback，死会话重建），随后 attach 流增量喂给 Ghostty。
 */
function SshTerminalViewport({
  environmentId,
  threadId,
  serverId,
  terminalId,
}: SshTerminalViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<GhosttyTerminalSurface | null>(null);
  const runOpen = useAtomCommand(sshTerminalEnvironment.open, { reportFailure: false });
  const runWrite = useAtomCommand(sshTerminalEnvironment.write, { reportFailure: false });
  const runResize = useAtomCommand(sshTerminalEnvironment.resize, { reportFailure: false });
  const font = useSshTerminalFont();
  const fontRef = useRef(font);
  fontRef.current = font;

  const attach = useEnvironmentQuery(
    sshTerminalEnvironment.attach({ environmentId, input: { threadId, terminalId } }),
  );
  const session: SshTerminalBufferState = attach.data ?? EMPTY_SSH_TERMINAL_BUFFER_STATE;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const previousRef = useRef<{ buffer: string; version: number }>({ buffer: "", version: 0 });
  const exitedAnnouncedRef = useRef(false);

  useEffect(() => {
    // open 是幂等的「确保在跑」；重复挂载不会顶掉正在跑的 shell。
    void runOpen({ environmentId, input: { threadId, terminalId, serverId } });
  }, [environmentId, threadId, serverId, terminalId, runOpen]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;
    let cancelled = false;
    let surface: GhosttyTerminalSurface | null = null;
    const setup = async () => {
      const currentFont = fontRef.current;
      const created = await GhosttyTerminalSurface.create(mount, {
        theme: terminalThemeFromApp(mount),
        font: {
          ...(currentFont.family.length > 0 ? { family: currentFont.family } : {}),
          size: currentFont.size || DEFAULT_TERMINAL_FONT_SIZE,
        },
        onData: (data) => void runWrite({ environmentId, input: { threadId, terminalId, data } }),
        onResize: (cols, rows) =>
          void runResize({ environmentId, input: { threadId, terminalId, cols, rows } }),
        // SSH 面板 v1 不做选择菜单/链接跳转，占位满足 surface 的必选回调。
        onSelectionChange: () => undefined,
        beforeKey: () => true,
        onLinkActivate: () => undefined,
      });
      if (cancelled) {
        created.dispose();
        return;
      }
      surface = created;
      terminalRef.current = created;
      const latest = sessionRef.current;
      previousRef.current = { buffer: latest.buffer, version: latest.version };
      if (latest.buffer.length > 0) created.resetAndWrite(latest.buffer);
      if (latest.status === "exited" || latest.status === "error") {
        exitedAnnouncedRef.current = true;
        writeSystemMessage(created, t("ssh.sessionEnded"));
      }
      created.focus();
    };
    void setup();
    return () => {
      cancelled = true;
      surface?.dispose();
      terminalRef.current = null;
    };
  }, [environmentId, threadId, terminalId, runWrite, runResize]);

  useEffect(() => {
    const surface = terminalRef.current;
    const previous = previousRef.current;
    if (!surface || session.version === previous.version) return;
    if (
      session.version === previous.version + 1 &&
      previous.version > 0 &&
      session.buffer.startsWith(previous.buffer)
    ) {
      surface.write(session.buffer.slice(previous.buffer.length));
    } else {
      surface.resetAndWrite(session.buffer);
    }
    if (
      (session.status === "exited" || session.status === "error") &&
      !exitedAnnouncedRef.current
    ) {
      exitedAnnouncedRef.current = true;
      writeSystemMessage(surface, t("ssh.sessionEnded"));
    }
    if (session.status === "running") exitedAnnouncedRef.current = false;
    previousRef.current = { buffer: session.buffer, version: session.version };
  }, [session]);

  useEffect(() => {
    const surface = terminalRef.current;
    if (!surface) return;
    void surface.setFont({
      ...(font.family.length > 0 ? { family: font.family } : {}),
      size: font.size || DEFAULT_TERMINAL_FONT_SIZE,
    });
  }, [font]);

  return (
    <div
      ref={containerRef}
      className="min-h-0 min-w-0 flex-1 overflow-hidden"
      data-ssh-terminal-viewport={terminalId}
    />
  );
}

export interface SshTerminalPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  serverId: string;
  serverLabel: string;
  terminalIds: readonly string[];
  activeTerminalId: string;
  onActivateTerminal: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string) => void;
  onNewTerminal: () => void;
}

export function SshTerminalPanel(props: SshTerminalPanelProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <span className="min-w-0 truncate text-muted-foreground text-xs" title={props.serverLabel}>
          {props.serverLabel}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {props.terminalIds.map((terminalId, index) => (
            <span
              key={terminalId}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs",
                terminalId === props.activeTerminalId
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <button
                type="button"
                className="cursor-pointer"
                onClick={() => props.onActivateTerminal(terminalId)}
              >
                {props.terminalIds.length > 1 ? `${index + 1}` : t("ssh.terminalTab")}
              </button>
              <button
                type="button"
                aria-label={t("ssh.closeTerminal")}
                className="cursor-pointer text-muted-foreground hover:text-foreground"
                onClick={() => props.onCloseTerminal(terminalId)}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
        <button
          type="button"
          aria-label={t("ssh.newTerminal")}
          className="shrink-0 cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
          onClick={props.onNewTerminal}
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      <SshTerminalViewport
        key={props.activeTerminalId}
        environmentId={props.environmentId}
        threadId={props.threadId}
        serverId={props.serverId as SshServerId}
        terminalId={props.activeTerminalId}
      />
    </div>
  );
}
