import type { ReactNode, Ref } from "react";

import { cn } from "../lib/utils";
import { t } from "../i18n";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";

// 切换时保留对话、旧面板及原生工作台节点，避免丢失草稿、编辑缓冲区和终端会话。
export function WorkspaceLayout(props: {
  ref?: Ref<HTMLDivElement>;
  ide: boolean;
  width: number;
  chatVisible: boolean;
  maximized: boolean;
  header: ReactNode;
  workbench: ReactNode;
  editor: ReactNode;
  terminal: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const chatHidden = props.ide ? !props.chatVisible : props.maximized;
  const chatMinWidth = 280;
  // 保留文件树与编辑区的基础空间，初次测量前仍使用默认对话宽度。
  const chatMaxWidth = Math.max(360, props.width - 480);
  const chatResize = useResizableWidth({
    storageKey: "codework.ideChatWidth",
    legacyStorageKey: undefined,
    defaultWidth: 360,
    minWidth: chatMinWidth,
    maxWidth: chatMaxWidth,
    edge: "left",
  });
  return (
    <div
      ref={props.ref}
      className={cn(
        "theme-content-shell relative grid min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
        props.ide && "codework-ide",
      )}
      data-workspace-layout={props.ide ? "ide" : "chat"}
      style={{
        gridTemplateAreas: props.ide
          ? props.chatVisible
            ? '"header header" "workbench conversation"'
            : '"header" "workbench"'
          : '"header editor" "conversation editor" "terminal editor"',
        gridTemplateColumns: props.ide
          ? `minmax(0, 1fr)${props.chatVisible ? ` ${chatResize.width}px` : ""}`
          : props.maximized
            ? "0 minmax(0, 1fr)"
            : "minmax(0, 1fr) auto",
        gridTemplateRows: props.ide ? "auto minmax(0, 1fr)" : "auto minmax(0, 1fr) auto",
      }}
    >
      <div
        className={cn("min-w-0 overflow-hidden", props.ide && "border-b border-border")}
        style={{ gridArea: "header" }}
        data-workspace-header-slot
        hidden={!props.ide && props.maximized}
      >
        {props.header}
      </div>
      <div
        className={props.ide ? "min-h-0 min-w-0" : "hidden"}
        style={{ gridArea: props.ide ? "workbench" : undefined }}
        hidden={!props.ide}
      >
        {props.workbench}
      </div>
      <div
        className={cn(
          "relative min-h-0 min-w-0 flex-col",
          chatHidden ? "hidden" : "flex",
          props.ide && "border-l border-border",
        )}
        style={{ gridArea: props.ide && !props.chatVisible ? undefined : "conversation" }}
        data-workspace-conversation
        hidden={chatHidden}
      >
        {props.ide && props.chatVisible ? (
          <RightPanelResizeHandle
            handlers={chatResize.handlers}
            width={chatResize.width}
            minWidth={chatMinWidth}
            maxWidth={chatMaxWidth}
            label={t("workspace.chatShort")}
            className="-left-1.5 z-30 w-3"
          />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {props.ide && props.chatVisible ? (
            <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3 text-xs font-medium text-muted-foreground">
              {t("workspace.chatShort")}
            </div>
          ) : null}
          {props.children}
        </div>
      </div>
      <div
        className={props.ide ? "hidden" : "min-h-0 min-w-0"}
        hidden={props.ide}
        style={{ gridArea: props.ide ? undefined : "terminal" }}
        data-workspace-terminal
      >
        {props.terminal}
      </div>
      <div
        className={props.ide ? "hidden" : "flex min-h-0 min-w-0 flex-col overflow-hidden"}
        hidden={props.ide}
        style={{ gridArea: props.ide ? undefined : "editor" }}
        data-workspace-editor
      >
        {props.editor}
      </div>
      {props.overlay}
    </div>
  );
}
