import { Loader2Icon } from "lucide-react";
import { cn } from "~/lib/utils";
import { t } from "~/i18n";

function Spinner({ className, ...props }: React.ComponentProps<typeof Loader2Icon>) {
  return (
    <Loader2Icon
      aria-label={t("loading3")}
      className={cn("animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
