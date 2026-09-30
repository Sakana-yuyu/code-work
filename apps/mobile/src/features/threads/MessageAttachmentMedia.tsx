import type { ChatAttachment, EnvironmentId } from "@codework/contracts";
import { useRef, useState } from "react";
import { ActivityIndicator, Image, View } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import { AppText as Text } from "../../components/AppText";
import { t } from "../../i18n";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrl } from "../../state/assets";

export function MessageAttachmentMedia(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatAttachment;
  readonly className: string;
  readonly onPressImage: (uri: string, headers?: Record<string, string>) => void;
}) {
  const uri = useAssetUrl(props.environmentId, {
    _tag: "attachment",
    attachmentId: props.attachment.id,
  });
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const openSequence = useRef(0);

  if (props.attachment.type === "image") {
    if (uri !== null && failedUri === uri) {
      return (
        <View className={`${props.className} items-center justify-center`}>
          <Text className="text-xs text-foreground-muted">{t("imageUnavailable")}</Text>
        </View>
      );
    }
    if (uri === null) {
      return (
        <View className={`${props.className} items-center justify-center`}>
          <ActivityIndicator />
        </View>
      );
    }
    return (
      <TouchableOpacity activeOpacity={0.7} onPress={() => props.onPressImage(uri)}>
        <Image
          source={{ uri }}
          className={props.className}
          resizeMode="cover"
          onError={() => setFailedUri(uri)}
        />
      </TouchableOpacity>
    );
  }

  const label =
    props.attachment.type === "audio"
      ? t("openAudioAttachment", { name: props.attachment.name })
      : t("downloadAttachment", { name: props.attachment.name });

  if (uri === null) {
    return (
      <View className="mt-1.5 min-h-10 items-center justify-center rounded-[14px] bg-neutral-200 px-3 py-2 dark:bg-neutral-800">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={failedUri === uri ? `${label}. ${t("attachmentOpenFailed")}` : label}
      onPress={async () => {
        const sequence = ++openSequence.current;
        const opened = await tryOpenExternalUrl(uri, "file-preview");
        if (sequence !== openSequence.current) return;
        setFailedUri((current) => (opened ? (current === uri ? null : current) : uri));
      }}
      className="mt-1.5 rounded-[14px] bg-neutral-200 px-3 py-2 dark:bg-neutral-800"
    >
      <Text className="text-xs text-foreground">{label}</Text>
      {failedUri === uri ? (
        <Text className="mt-1 text-xs text-foreground-muted">{t("attachmentOpenFailed")}</Text>
      ) : null}
    </TouchableOpacity>
  );
}
