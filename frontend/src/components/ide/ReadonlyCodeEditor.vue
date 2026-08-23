<script setup>
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = defineProps({
  text: { type: String, default: "" },
  readOnly: { type: Boolean, default: true },
  fileKey: { type: String, default: "" },
});

const emit = defineEmits(["update:text"]);
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
});

function editorExtensions() {
  const extras = props.readOnly
    ? [EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.theme({ ".cm-content": { caretColor: "transparent" } })]
    : [EditorView.updateListener.of((update) => {
      if (update.docChanged) emit("update:text", update.state.doc.toString());
    })];
  return [lineNumbers(), ...extras, editorTheme];
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
  () => [props.fileKey, props.readOnly],
  () => {
    if (!view) return;
    view.setState(createState(props.text));
  },
);

onBeforeUnmount(() => {
  view?.destroy();
  view = null;
});
</script>

<template>
  <div ref="hostRef" class="readonly-code-editor" :aria-label="readOnly ? '只读编辑器' : '代码编辑器'" />
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
