#pragma once

#include <react/renderer/components/CodeworkMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/CodeworkMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char CodeworkMarkdownTextComponentName[];

struct CodeworkMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct CodeworkMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float CodeworkMarkdownTextAttachmentSize(const CodeworkMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float CodeworkMarkdownTextAttachmentBaselineOffset(
    const CodeworkMarkdownTextAttachmentRange &) {
  return -2;
}

class CodeworkMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<CodeworkMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<CodeworkMarkdownTextAttachmentRange> attachmentRanges;
};

class CodeworkMarkdownTextShadowNode final : public ConcreteViewShadowNode<
CodeworkMarkdownTextComponentName,
CodeworkMarkdownTextProps,
CodeworkMarkdownTextEventEmitter,
CodeworkMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  CodeworkMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<CodeworkMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<CodeworkMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
