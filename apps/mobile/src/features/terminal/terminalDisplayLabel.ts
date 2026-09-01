import { terminalLabelTranslation } from "@codework/shared/terminalLabels";

import { t } from "../../i18n/runtime";

/** 终端标签可能是服务端下发的英文默认名（"Terminal N"）；展示前翻译，其余原样。 */
export function terminalDisplayLabel(label: string): string {
  const known = terminalLabelTranslation(label);
  return known === null ? label : t(known.key, known.params);
}
