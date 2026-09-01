#pragma once

#include <react/renderer/components/CodeworkMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/CodeworkMarkdownTextSpec/Props.h>
#include <react/renderer/components/CodeworkMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char CodeworkMarkdownTextRunComponentName[];

using CodeworkMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    CodeworkMarkdownTextRunComponentName,
    CodeworkMarkdownTextRunProps,
    CodeworkMarkdownTextRunEventEmitter,
    CodeworkMarkdownTextRunState>;
}
