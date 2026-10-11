import { RESPONSE_STREAMING_MODES, type ResponseStreamingMode } from "@codework/contracts";
import { t } from "~/i18n";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function ResponseStreamingModeControl(props: {
  readonly mode: ResponseStreamingMode;
  readonly supported: boolean;
  readonly onChange: (mode: ResponseStreamingMode) => void;
}) {
  return (
    <Select
      value={props.mode}
      disabled={!props.supported}
      onValueChange={(value) => {
        const mode = RESPONSE_STREAMING_MODES.find((candidate) => candidate === value);
        if (props.supported && mode !== undefined) props.onChange(mode);
      }}
    >
      <SelectTrigger
        className="w-full sm:w-52"
        aria-label={t("settings.responseStreamingMode")}
        disabled={!props.supported}
      >
        <SelectValue>{t(`settings.responseStreaming.${props.mode}`)}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {RESPONSE_STREAMING_MODES.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {t(`settings.responseStreaming.${mode}`)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
