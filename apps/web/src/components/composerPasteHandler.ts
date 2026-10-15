import { COMMAND_PRIORITY_CRITICAL, PASTE_COMMAND, type LexicalEditor } from "lexical";

export interface ComposerPasteEvent {
  readonly clipboardData: DataTransfer;
  preventDefault: () => void;
}

// Runs ahead of Lexical's plain-text insert. Returning true when the handler
// prevented the paste stops the insert, so a paste that becomes an attachment
// does not also land in the editor.
export function registerComposerPasteHandler(
  editor: LexicalEditor,
  onPaste: (event: ComposerPasteEvent) => void,
): () => void {
  return editor.registerCommand(
    PASTE_COMMAND,
    (event) => {
      if (!(event instanceof ClipboardEvent) || event.clipboardData === null) {
        return false;
      }
      const clipboardData = event.clipboardData;
      onPaste({ clipboardData, preventDefault: () => event.preventDefault() });
      return event.defaultPrevented;
    },
    COMMAND_PRIORITY_CRITICAL,
  );
}
