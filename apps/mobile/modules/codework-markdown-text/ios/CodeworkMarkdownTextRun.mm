#import "CodeworkMarkdownTextRun.h"
#import "CodeworkMarkdownText.h"
#import "CodeworkMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/CodeworkMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/CodeworkMarkdownTextSpec/Props.h>
#import <react/renderer/components/CodeworkMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface CodeworkMarkdownTextRun () <RCTCodeworkMarkdownTextRunViewProtocol>

@end

@implementation CodeworkMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<CodeworkMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const CodeworkMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<CodeworkMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<CodeworkMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::CodeworkMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::CodeworkMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::CodeworkMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::CodeworkMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> CodeworkMarkdownTextRunCls(void)
{
    return CodeworkMarkdownTextRun.class;
}

@end
