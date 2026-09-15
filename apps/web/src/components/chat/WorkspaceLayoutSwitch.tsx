import { MessageSquareIcon, SquareCodeIcon } from "lucide-react";

import { useIdeViewportAvailable } from "../../workspaceLayout";
import { t } from "~/i18n";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The chat ⇄ IDE layout switch. It lives in the page header and, duplicated,
 * in the right-panel sheet's tab bar: the open sheet covers the header's
 * right side, so without a second instance up there the layout mode becomes
 * a one-way door whenever a panel is open.
 */
export function WorkspaceLayoutSwitch(props: {
  value: "chat" | "ide";
  onChange: (mode: "chat" | "ide") => void;
  className?: string;
}) {
  const ideAvailable = useIdeViewportAvailable();
  const layoutOptions = [
    {
      value: "chat",
      label: t("workspace.chatMode"),
      shortLabel: t("workspace.chatShort"),
      icon: MessageSquareIcon,
    },
    { value: "ide", label: t("workspace.ideMode"), shortLabel: "IDE", icon: SquareCodeIcon },
  ] as const;
  return (
    <div
      role="group"
      aria-label={t("workspace.layout")}
      className={cn("flex shrink-0 items-center [-webkit-app-region:no-drag]", props.className)}
    >
      <div className="flex h-8 items-center gap-0.5 rounded-lg border border-border/60 bg-muted/50 p-0.5">
        {layoutOptions.map(({ value, label, shortLabel, icon: Icon }) => (
          <Tooltip key={value}>
            <TooltipTrigger render={<span className="flex" />}>
              <Button
                size="sm"
                variant="ghost"
                className={cn(
                  "h-6! gap-1.5 rounded-md border-0 px-2.5 text-xs font-medium",
                  props.value === value
                    ? "bg-background text-foreground shadow-xs ring-1 ring-border/50"
                    : "text-muted-foreground",
                )}
                aria-label={label}
                aria-pressed={props.value === value}
                disabled={value === "ide" && !ideAvailable}
                onClick={() => props.onChange(value)}
              >
                <Icon
                  className={cn(
                    "size-3.5",
                    props.value === value ? "text-primary" : "text-muted-foreground",
                  )}
                />
                {shortLabel}
              </Button>
            </TooltipTrigger>
            <TooltipPopup>
              {value === "ide" && !ideAvailable ? t("workspace.ideNeedsSpace") : label}
            </TooltipPopup>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
