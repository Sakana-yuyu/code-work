package expo.modules.codeworkcomposereditor

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CodeworkComposerEditorModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CodeworkComposerEditor")

    View(CodeworkComposerEditorView::class) {
      Prop("controlledDocumentJson") { view: CodeworkComposerEditorView, documentJson: String ->
        view.setControlledDocumentJson(documentJson)
      }
      Prop("themeJson") { view: CodeworkComposerEditorView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("placeholder") { view: CodeworkComposerEditorView, placeholder: String ->
        view.setPlaceholder(placeholder)
      }
      Prop("fontFamily") { view: CodeworkComposerEditorView, fontFamily: String ->
        view.setFontFamily(fontFamily)
      }
      Prop("fontSize") { view: CodeworkComposerEditorView, fontSize: Double ->
        view.setFontSize(fontSize.toFloat())
      }
      Prop("lineHeight") { view: CodeworkComposerEditorView, lineHeight: Double ->
        view.setLineHeight(lineHeight.toFloat())
      }
      Prop("contentInsetVertical") {
          view: CodeworkComposerEditorView,
          contentInsetVertical: Double
        ->
        view.setContentInsetVertical(contentInsetVertical.toInt())
      }

      Prop("singleLineCentered") { view: CodeworkComposerEditorView, singleLineCentered: Boolean ->
        view.setSingleLineCentered(singleLineCentered)
      }
      Prop("editable") { view: CodeworkComposerEditorView, editable: Boolean ->
        view.setEditable(editable)
      }
      Prop("scrollEnabled") { view: CodeworkComposerEditorView, scrollEnabled: Boolean ->
        view.setScrollEnabled(scrollEnabled)
      }
      Prop("autoFocus") { view: CodeworkComposerEditorView, autoFocus: Boolean ->
        view.setAutoFocus(autoFocus)
      }
      Prop("autoCorrect") { view: CodeworkComposerEditorView, autoCorrect: Boolean ->
        view.setAutoCorrect(autoCorrect)
      }
      Prop("spellCheck") { view: CodeworkComposerEditorView, spellCheck: Boolean ->
        view.setSpellCheck(spellCheck)
      }

      Events(
        "onComposerChange",
        "onComposerSelectionChange",
        "onComposerFocus",
        "onComposerBlur",
        "onComposerPasteImages",
        "onComposerContentSizeChange",
      )

      AsyncFunction("focus") { view: CodeworkComposerEditorView ->
        view.focusEditor()
      }
      AsyncFunction("blur") { view: CodeworkComposerEditorView ->
        view.blurEditor()
      }
      AsyncFunction("setSelection") { view: CodeworkComposerEditorView, start: Int, end: Int ->
        view.setSelection(start, end)
      }
    }
  }
}
