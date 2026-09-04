package expo.modules.codeworkreviewdiff

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class CodeworkReviewDiffModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("CodeworkReviewDiffSurface")

    View(CodeworkReviewDiffView::class) {
      Prop("tokensResetKey") { view: CodeworkReviewDiffView, tokensResetKey: String ->
        view.setTokensResetKey(tokensResetKey)
      }
      Prop("contentResetKey") { view: CodeworkReviewDiffView, contentResetKey: String ->
        view.setContentResetKey(contentResetKey)
      }
      Prop("collapsedFileIdsJson") { view: CodeworkReviewDiffView, collapsedFileIdsJson: String ->
        view.setCollapsedFileIdsJson(collapsedFileIdsJson)
      }
      Prop("viewedFileIdsJson") { view: CodeworkReviewDiffView, viewedFileIdsJson: String ->
        view.setViewedFileIdsJson(viewedFileIdsJson)
      }
      Prop("selectedRowIdsJson") { view: CodeworkReviewDiffView, selectedRowIdsJson: String ->
        view.setSelectedRowIdsJson(selectedRowIdsJson)
      }
      Prop("collapsedCommentIdsJson") {
          view: CodeworkReviewDiffView,
          collapsedCommentIdsJson: String
        ->
        view.setCollapsedCommentIdsJson(collapsedCommentIdsJson)
      }
      Prop("appearanceScheme") { view: CodeworkReviewDiffView, appearanceScheme: String ->
        view.setAppearanceScheme(appearanceScheme)
      }
      Prop("themeJson") { view: CodeworkReviewDiffView, themeJson: String ->
        view.setThemeJson(themeJson)
      }
      Prop("styleJson") { view: CodeworkReviewDiffView, styleJson: String ->
        view.setStyleJson(styleJson)
      }
      Prop("rowHeight") { view: CodeworkReviewDiffView, rowHeight: Double ->
        view.setRowHeight(rowHeight.toFloat())
      }
      Prop("contentWidth") { view: CodeworkReviewDiffView, contentWidth: Double ->
        view.setContentWidth(contentWidth.toFloat())
      }
      Prop("initialRowIndex") { view: CodeworkReviewDiffView, initialRowIndex: Double ->
        view.setInitialRowIndex(initialRowIndex)
      }

      Events(
        "onDebug",
        "onVisibleFileChange",
        "onToggleFile",
        "onToggleViewedFile",
        "onPressLine",
        "onToggleComment",
      )

      AsyncFunction("scrollToFile") {
          view: CodeworkReviewDiffView,
          fileId: String,
          animated: Boolean
        ->
        view.scrollToFile(fileId, animated)
      }
      AsyncFunction("scrollToTop") { view: CodeworkReviewDiffView, animated: Boolean ->
        view.scrollToTop(animated)
      }
      AsyncFunction("setRowsJson") { view: CodeworkReviewDiffView, rowsJson: String ->
        view.setRowsJson(rowsJson)
      }
      AsyncFunction("setTokensJson") { view: CodeworkReviewDiffView, tokensJson: String ->
        view.setTokensJson(tokensJson)
      }
      AsyncFunction("setTokensPatchJson") { view: CodeworkReviewDiffView, tokensPatchJson: String ->
        view.setTokensPatchJson(tokensPatchJson)
      }

      OnViewDestroys { view: CodeworkReviewDiffView ->
        view.cleanup()
      }
    }
  }
}
