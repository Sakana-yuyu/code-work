import { useEffect, useRef, type ReactNode, type Ref } from "react";

import { cn } from "../lib/utils";
import { t } from "../i18n";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { ideChatWidthForEditor, ideEditorGivesWay, IDE_CHAT_MIN_WIDTH } from "../workspaceLayout";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";

// 切换时保留对话、旧面板及原生工作台节点，避免丢失草稿、编辑缓冲区和终端会话。
export function WorkspaceLayout(props: {
  ref?: Ref<HTMLDivElement>;
  ide: boolean;
  width: number;
  chatVisible: boolean;
  maximized: boolean;
  /** 打开文件时递增。编辑器已让位时，把对话列收回，编辑器重新出现。 */
  editorRequestId?: number;
  header: ReactNode;
  workbench: ReactNode;
  editor: ReactNode;
  terminal: ReactNode;
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const chatHidden = props.ide ? !props.chatVisible : props.maximized;
  const chatMinWidth = IDE_CHAT_MIN_WIDTH;
  // 分隔条可以拖过编辑器的最小宽度，直到对话占满这一行。
  const chatMaxWidth = Math.max(chatMinWidth, props.width);
  const chatResize = useResizableWidth({
    storageKey: "codework.ideChatWidth",
    legacyStorageKey: undefined,
    defaultWidth: 360,
    minWidth: chatMinWidth,
    maxWidth: chatMaxWidth,
    edge: "left",
  });
  const editorGivesWay =
    props.ide && props.chatVisible && ideEditorGivesWay(props.width, chatResize.width);
  const editorRequestId = props.editorRequestId ?? 0;
  const seenEditorRequestId = useRef(editorRequestId);
  useEffect(() => {
    if (editorRequestId === seenEditorRequestId.current) return;
    seenEditorRequestId.current = editorRequestId;
    if (!props.ide || editorRequestId === 0 || props.width <= 0) return;
    chatResize.setWidth(ideChatWidthForEditor(props.width, chatResize.width));
  }, [chatResize, editorRequestId, props.ide, props.width]);
  return (
    <div
      ref={props.ref}
      className={cn(
        "theme-content-shell relative grid min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
        props.ide && "codework-ide",
      )}
      data-workspace-layout={props.ide ? "ide" : "chat"}
      data-ide-editor-visible={props.ide ? String(!editorGivesWay) : undefined}
      style={{
        gridTemplateAreas: props.ide
          ? editorGivesWay
            ? '"header" "conversation"'
            : props.chatVisible
              ? '"header header" "workbench conversation"'
              : '"header" "workbench"'
          : '"header editor" "conversation editor" "terminal editor"',
        gridTemplateColumns: props.ide
          ? editorGivesWay
            ? "minmax(0, 1fr)"
            : `minmax(0, 1fr)${props.chatVisible ? ` ${chatResize.width}px` : ""}`
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
        className={props.ide && !editorGivesWay ? "min-h-0 min-w-0" : "hidden"}
        style={{ gridArea: props.ide && !editorGivesWay ? "workbench" : undefined }}
        hidden={!props.ide || editorGivesWay}
      >
        {props.workbench}
      </div>
      <div
        className={cn(
          "relative min-h-0 min-w-0 flex-col",
          chatHidden ? "hidden" : "flex",
          props.ide && !editorGivesWay && "border-l border-border",
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
              <span className="min-w-0 truncate">{t("workspace.chatShort")}</span>
              <button
                type="button"
                className="ml-auto shrink-0 rounded-md px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50"
                disabled={props.width <= 0}
                onClick={() => {
                  const next = editorGivesWay
                    ? ideChatWidthForEditor(props.width, chatResize.width)
                    : props.width;
                  chatResize.setWidth(next);
                }}
              >
                {editorGivesWay ? t("workspace.showEditor") : t("workspace.maximizeChat")}
              </button>
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
