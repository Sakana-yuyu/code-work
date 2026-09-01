#pragma once

#include "CodeworkMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using CodeworkMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<CodeworkMarkdownTextRunShadowNode>;

void CodeworkMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
