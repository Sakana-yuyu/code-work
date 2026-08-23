<script setup>
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  text: { type: String, default: "" },
});

const hostRef = ref(null);
let view = null;

const editorTheme = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--cw-surface-workbench)",
    color: "var(--cw-text-secondary)",
    fontSize: "12px",
  },
  ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" },
  ".cm-gutters": {
    backgroundColor: "var(--cw-surface-raised)",
    color: "var(--cw-text-muted)",
    borderRight: "1px solid var(--cw-border-subtle)",
  },
  ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "transparent" },
  ".cm-content": { caretColor: "transparent" },
});

function editorExtensions() {
  return [
    lineNumbers(),
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    editorTheme,
  ];
}

function createState(text) {
  return EditorState.create({
    doc: text ?? "",
    extensions: editorExtensions(),
  });
}

onMounted(() => {
  if (!hostRef.value) return;
  view = new EditorView({
    state: createState(props.text),
    parent: hostRef.value,
  });
});

watch(
  () => props.text,
  (text) => {
    if (!view) return;
    view.setState(createState(text));
  },
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="hostRef" class="readonly-code-editor" aria-label="只读编辑器" />
</template>

<style scoped>
.readonly-code-editor {
  min-height: 220px;
  height: 100%;
  overflow: hidden;
  border: 1px solid var(--cw-border-subtle);
  border-radius: var(--cw-radius-sm);
  background: var(--cw-surface-workbench);
}
.readonly-code-editor :deep(.cm-editor) {
  height: 100%;
}
</style>
