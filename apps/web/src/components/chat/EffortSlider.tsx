import type { ProviderOptionDescriptor } from "@codework/contracts";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { ChevronRightIcon, RotateCcwIcon, ZapIcon } from "lucide-react";
import { t } from "~/i18n";
import { CATALOGS } from "~/i18n/runtime";
import type { ClientSettings } from "@codework/contracts/settings";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import "./EffortSlider.css";

export function effortOptionLabel(
  option: { id: string; label: string },
  language: ClientSettings["effortLabelLanguage"] = "en",
): string {
  const key = `effortPicker.value.${option.id}`;
  return CATALOGS[language][key] ?? option.label;
}

export function EffortSlider({
  descriptor,
  labelLanguage,
  selectedValue,
  modelLabel,
  disabled,
  disabledReason,
  fastModeEnabled,
  onFastModeChange,
  onValueChange,
  children,
}: {
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>;
  labelLanguage: ClientSettings["effortLabelLanguage"];
  selectedValue: string | null;
  modelLabel: string;
  disabled: boolean;
  disabledReason: string | undefined;
  fastModeEnabled: boolean;
  onFastModeChange: (() => void) | undefined;
  onValueChange: (value: string) => void;
  children: ReactNode;
}) {
  const [dragValue, setDragValue] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [keyboardInput, setKeyboardInput] = useState(false);
  const [starsVisible, setStarsVisible] = useState(false);
  const sliderRef = useRef<HTMLDivElement>(null);
  const pointerId = useRef<number | null>(null);
  const index = descriptor.options.findIndex((option) => option.id === selectedValue);
  const selected = descriptor.options[index];
  const defaultOption = descriptor.options.find((option) => option.isDefault);
  const lastIndex = descriptor.options.length - 1;
  const progress = lastIndex > 0 ? (dragValue ?? Math.max(0, index)) / lastIndex : 0;
  const isUltra = selectedValue === "ultra" || selectedValue === "ultrathink";
  const selectedLabel = selected
    ? effortOptionLabel(selected, labelLanguage)
    : t("effortPicker.select");

  useEffect(() => {
    const slider = sliderRef.current;
    if (!slider) return;
    let inView = false;
    const updateVisibility = () => setStarsVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry?.isIntersecting ?? false;
      updateVisibility();
    });
    observer.observe(slider);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  const endDrag = () => {
    pointerId.current = null;
    setDragValue(null);
    setDragging(false);
  };

  return (
    <div
      className="w-60 max-w-full"
      data-effort-slider-panel
      onPointerDownCapture={() => setKeyboardInput(false)}
    >
      <div className="grid grid-cols-[2rem_minmax(0,1fr)_2rem] items-start gap-1">
        {onFastModeChange ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={cn(
                    "rounded-full",
                    fastModeEnabled && "text-violet-600 dark:text-violet-400",
                  )}
                  aria-label={t("effortPicker.fastMode")}
                  aria-pressed={fastModeEnabled}
                  onClick={onFastModeChange}
                />
              }
            >
              <ZapIcon aria-hidden className={cn("size-3.5", fastModeEnabled && "fill-current")} />
            </TooltipTrigger>
            <TooltipPopup>{t("effortPicker.fastMode")}</TooltipPopup>
          </Tooltip>
        ) : (
          <span className="flex size-8 items-center justify-center text-muted-foreground">
            <ZapIcon aria-hidden className="size-3.5" />
          </span>
        )}
        <div className="flex min-w-0 flex-col items-center">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="effort-tone h-7 max-w-full gap-0.5 px-2"
                  data-effort={selectedValue}
                />
              }
              aria-label={t("effortPicker.allOptions")}
            >
              <span className="truncate">{selectedLabel}</span>
              <ChevronRightIcon aria-hidden className="size-3 text-muted-foreground" />
            </MenuTrigger>
            <MenuPopup
              side="top"
              align="center"
              className="effort-picker-popup max-w-[calc(100vw-2rem)]"
            >
              {children}
            </MenuPopup>
          </Menu>
          <Tooltip>
            <TooltipTrigger
              render={<span className="max-w-full truncate text-xs text-muted-foreground" />}
            >
              {modelLabel}
            </TooltipTrigger>
            <TooltipPopup>{modelLabel}</TooltipPopup>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                className="rounded-full"
                aria-label={t("effortPicker.reset")}
                disabled={disabled || !defaultOption || defaultOption.id === selectedValue}
                onClick={() => {
                  if (defaultOption) onValueChange(defaultOption.id);
                }}
              />
            }
          >
            <RotateCcwIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>{t("effortPicker.reset")}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        ref={sliderRef}
        className="effort-slider effort-tone relative mt-2 h-10"
        data-effort={selectedValue}
        data-instant={dragging || keyboardInput}
        data-stars-paused={!starsVisible || progress === 0 || disabled}
        data-disabled={disabled || lastIndex < 1}
        data-ultra={isUltra}
      >
        <div aria-hidden className="effort-slider-track">
          <div className="effort-slider-ultra" />
          <div className="effort-slider-stars" style={{ opacity: progress }} />
          <div
            className="effort-slider-stars effort-slider-stars-dense"
            style={{ opacity: progress ** 3 }}
          />
          <div
            className="effort-slider-cover"
            style={{ transform: `translateX(calc(14px + (100% - 28px) * ${progress}))` }}
          />
          <div className="absolute inset-x-3.5 inset-y-0 flex items-center justify-between">
            {descriptor.options.map((option, optionIndex) => (
              <span
                key={option.id}
                className={cn(
                  "size-1 rounded-full",
                  optionIndex <= index ? "bg-white/40" : "bg-foreground/20",
                )}
              />
            ))}
          </div>
        </div>
        <div
          aria-hidden
          className="effort-slider-thumb-position"
          style={{ transform: `translateX(${progress * 100}%)` }}
        >
          <div className="effort-slider-thumb" />
        </div>
        <input
          type="range"
          className="effort-slider-input"
          min={0}
          max={Math.max(0, lastIndex)}
          step={dragValue === null ? 1 : "any"}
          value={dragValue ?? Math.max(0, index)}
          disabled={disabled || lastIndex < 1}
          aria-label={t("effortPicker.label")}
          aria-valuetext={selectedLabel}
          aria-description={disabledReason ?? selected?.description}
          onPointerDown={(event) => {
            if (!event.isPrimary || event.button !== 0) return;
            pointerId.current = event.pointerId;
            event.currentTarget.setPointerCapture(event.pointerId);
            setDragValue(Math.max(0, index));
          }}
          onPointerUp={(event) => {
            if (pointerId.current === event.pointerId) endDrag();
          }}
          onPointerMove={(event) => {
            if (pointerId.current === event.pointerId) setDragging(true);
          }}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onBlur={endDrag}
          onKeyDown={() => setKeyboardInput(true)}
          onChange={(event) => {
            const value = event.currentTarget.valueAsNumber;
            if (pointerId.current !== null) setDragValue(value);
            // 拖动连续跟手，只在跨越档位时保存；键盘仍使用原生整数步进。
            const option = descriptor.options[Math.round(value)];
            if (option && option.id !== selectedValue) onValueChange(option.id);
          }}
        />
      </div>
      {disabledReason ? (
        <p className="mt-1 text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
    </div>
  );
}
