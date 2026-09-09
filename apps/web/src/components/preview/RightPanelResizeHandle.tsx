import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";
import { t } from "~/i18n";

interface Props {
  handlers: ResizableWidthHandlers;
  className?: string;
  width: number;
  minWidth: number;
  maxWidth: number;
  label?: string;
}

/**
 * Hit target for resizing a right-anchored panel via its left edge.
 *
 * - Sits on top of the panel's border with a 4px overlap on each side so the
 *   user can grab a few pixels off the edge without aiming.
 * - Visual indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor.
 */
export function RightPanelResizeHandle({
  handlers,
  className,
  width,
  minWidth,
  maxWidth,
  label,
}: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label ?? t("resizeSidebar")}
      aria-valuenow={Math.round(width)}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      className={cn(
        "group absolute inset-y-0 -left-1 z-20 w-2 touch-none cursor-col-resize select-none outline-none",
        className,
      )}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-primary/60 group-focus-visible:bg-primary group-active:bg-primary"
      />
    </div>
  );
}
