#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface CodeworkMarkdownTextManager : RCTViewManager
@end

@implementation CodeworkMarkdownTextManager

RCT_EXPORT_MODULE(CodeworkMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface CodeworkMarkdownTextRunManager : RCTViewManager
@end

@implementation CodeworkMarkdownTextRunManager

RCT_EXPORT_MODULE(CodeworkMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
