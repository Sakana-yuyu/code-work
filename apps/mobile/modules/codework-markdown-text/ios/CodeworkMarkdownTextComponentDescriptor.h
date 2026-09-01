#pragma once

#include "CodeworkMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using CodeworkMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<CodeworkMarkdownTextShadowNode>;

void CodeworkMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
