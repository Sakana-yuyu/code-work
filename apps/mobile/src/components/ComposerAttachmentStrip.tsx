import { SymbolView } from "../components/AppSymbol";
import { formatAttachmentSize } from "@codework/client-runtime/state/attachments";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import { useThemeColor } from "../lib/useThemeColor";

import type { DraftComposerAttachment } from "../lib/composerImages";

export interface ComposerAttachmentStripProps {
  /** Attachments to display: images as thumbnails, files as name chips. */
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  /** Called when the user taps the remove button on an attachment. */
  readonly onRemove: (imageId: string) => void;
  /** Called when the user taps on an image thumbnail to preview it. */
  readonly onPressImage?: (previewUri: string) => void;
  /** Image thumbnail size in points.  Defaults to 72. */
  readonly imageSize?: number;
  /** Border radius of each image thumbnail.  Defaults to 16. */
  readonly imageBorderRadius?: number;
  /** Whether the remove button should sit in its own gutter instead of overlapping the image. */
  readonly removeButtonPlacement?: "overlay" | "gutter";
}

/**
 * A horizontally-scrollable strip of attachment thumbnails and file chips with
 * remove buttons.  Used by both the thread composer and the new-task draft screen.
 */
export function ComposerAttachmentStrip(props: ComposerAttachmentStripProps) {
  const subtleBg = useThemeColor("--color-subtle");
  const mutedForeground = useThemeColor("--color-foreground-muted");
  const size = props.imageSize ?? 72;
  const radius = props.imageBorderRadius ?? 16;
  const removeButtonPlacement = props.removeButtonPlacement ?? "overlay";
  const removeButtonGutter = removeButtonPlacement === "gutter" ? 10 : 0;

  if (props.attachments.length === 0) {
    return null;
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="always"
      className="grow-0"
    >
      <View className="flex-row gap-2.5">
        {props.attachments.map((image) => (
          <View
            key={image.id}
            className="relative"
            style={{
              paddingTop: removeButtonGutter,
              paddingRight: removeButtonGutter,
            }}
          >
            {image.type === "image" ? (
              <Pressable
                onPress={
                  props.onPressImage ? () => props.onPressImage!(image.previewUri) : undefined
                }
              >
                <Image
                  source={{ uri: image.previewUri }}
                  style={{
                    width: size,
                    height: size,
                    borderRadius: radius,
                    backgroundColor: subtleBg,
                  }}
                  resizeMode="cover"
                />
              </Pressable>
            ) : (
              <View
                className="justify-center gap-1 px-3"
                style={{
                  width: size * 2,
                  height: size,
                  borderRadius: radius,
                  backgroundColor: subtleBg,
                }}
              >
                <SymbolView
                  name="doc.text"
                  size={16}
                  tintColor={mutedForeground}
                  type="monochrome"
                />
                <Text numberOfLines={1} className="text-foreground text-xs font-codework-medium">
                  {image.name}
                </Text>
                <Text className="text-foreground-muted text-2xs">
                  {formatAttachmentSize(image.sizeBytes)}
                </Text>
              </View>
            )}
            <Pressable
              className="absolute h-[22px] w-[22px] items-center justify-center rounded-[11px] bg-black/55"
              style={{
                top: removeButtonPlacement === "gutter" ? 0 : 4,
                right: removeButtonPlacement === "gutter" ? 0 : 4,
              }}
              hitSlop={6}
              onPress={() => props.onRemove(image.id)}
            >
              <SymbolView
                name="xmark"
                size={9}
                tintColor="#ffffff"
                type="monochrome"
                weight="bold"
              />
            </Pressable>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
