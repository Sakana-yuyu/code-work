import { useEffect, useRef, useState } from "react";
import type { CliProxyAccountOffer, CliProxyCaptchaConfig } from "@codework/contracts";

import { getCurrentLanguage, t } from "~/i18n/runtime";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { cn } from "~/lib/utils";

/** 阿里云验证码 2.0 Web SDK 的全局入口（脚本加载后注入）。 */
declare global {
  interface Window {
    initAliyunCaptcha?: (options: {
      SceneId: string;
      prefix: string;
      mode: "popup";
      element: string;
      button: string;
      language: "cn" | "en";
      region?: string;
      success: (captchaVerifyParam: string) => void;
      fail: () => void;
      onError: (error: unknown) => void;
      getInstance?: (instance: { destroy?: () => void }) => void;
    }) => void;
  }
}

const CAPTCHA_SCRIPT_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
let captchaScriptPromise: Promise<void> | null = null;

const loadCaptchaScript = (): Promise<void> => {
  captchaScriptPromise ??= new Promise((resolve, reject) => {
    if (typeof window === "undefined") {
      reject(new Error("captcha unavailable"));
      return;
    }
    if (window.initAliyunCaptcha !== undefined) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = CAPTCHA_SCRIPT_URL;
    script.async = true;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => {
        captchaScriptPromise = null;
        reject(new Error("captcha script failed"));
      },
      { once: true },
    );
    document.head.appendChild(script);
  });
  return captchaScriptPromise;
};

export type ClaimOfferResult = {
  readonly success: boolean;
  readonly message?: string | undefined;
  readonly planName?: string | undefined;
};

/**
 * 体验套餐领取弹窗（D2）：内嵌阿里云验证码拿 captchaVerifyParam，再由服务端
 * 代领。验证码脚本/域名校验失败时回退为「去官方客户端领取」的引导。
 */
export const ClaimOfferDialog = ({
  offer,
  captchaConfig,
  pending,
  result,
  onClose,
  onClaim,
}: {
  readonly offer: CliProxyAccountOffer | null;
  readonly captchaConfig: CliProxyCaptchaConfig | undefined;
  readonly pending: boolean;
  readonly result: ClaimOfferResult | null;
  readonly onClose: () => void;
  readonly onClaim: (captchaVerifyParam: string, captchaRegion?: string) => void;
}) => {
  const [scriptFailed, setScriptFailed] = useState(false);
  const [captchaReady, setCaptchaReady] = useState(false);
  const instanceRef = useRef<{ destroy?: () => void } | null>(null);
  const onClaimRef = useRef(onClaim);
  onClaimRef.current = onClaim;
  const elementId = "codework-captcha-element";
  const buttonId = "codework-captcha-button";

  useEffect(() => {
    setCaptchaReady(false);
    setScriptFailed(false);
    if (offer === null) return;
    if (captchaConfig?.enabled !== true) return;
    let cancelled = false;
    loadCaptchaScript()
      .then(() => {
        if (cancelled) return;
        const init = window.initAliyunCaptcha;
        if (init === undefined) {
          setScriptFailed(true);
          return;
        }
        init({
          SceneId: captchaConfig.sceneId,
          prefix: captchaConfig.prefix,
          mode: "popup",
          element: `#${elementId}`,
          button: `#${buttonId}`,
          language: getCurrentLanguage() === "zh-CN" ? "cn" : "en",
          ...(captchaConfig.region === undefined ? {} : { region: captchaConfig.region }),
          success: (captchaVerifyParam) => {
            if (!cancelled) onClaimRef.current(captchaVerifyParam, captchaConfig.region);
          },
          fail: () => {
            if (!cancelled) setScriptFailed(true);
          },
          onError: () => {
            if (!cancelled) setScriptFailed(true);
          },
          getInstance: (instance) => {
            if (cancelled) instance.destroy?.();
            else instanceRef.current = instance;
          },
        });
        setCaptchaReady(true);
      })
      .catch(() => {
        if (!cancelled) setScriptFailed(true);
      });
    return () => {
      cancelled = true;
      instanceRef.current?.destroy?.();
      instanceRef.current = null;
    };
  }, [
    offer,
    captchaConfig?.enabled,
    captchaConfig?.sceneId,
    captchaConfig?.prefix,
    captchaConfig?.region,
  ]);

  const captchaUsable = captchaConfig?.enabled === true && !scriptFailed;

  return (
    <Dialog
      open={offer !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogPopup className="w-full max-w-lg p-0">
        <DialogHeader>
          <DialogTitle>{t("cliProxy.claimDialogTitle")}</DialogTitle>
          {offer !== null && result === null ? (
            <DialogDescription>
              {offer.description?.trim() ? `${offer.name} · ${offer.description}` : offer.name}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {offer === null ? null : (
          <div className="px-6 pb-4">
            {result !== null ? (
              <Alert variant={result.success ? "success" : "error"}>
                <AlertTitle>
                  {result.success
                    ? t("cliProxy.claimSuccess", { plan: result.planName ?? offer.name })
                    : t("cliProxy.claimFailed")}
                </AlertTitle>
                {!result.success && result.message !== undefined ? (
                  <AlertDescription className="break-all">{result.message}</AlertDescription>
                ) : null}
              </Alert>
            ) : captchaUsable ? (
              <>
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {offer.entitlements.map((entitlement) => (
                    <li
                      key={`${entitlement.model ?? ""}-${entitlement.amount}-${entitlement.period ?? ""}`}
                    >
                      {[
                        entitlement.model,
                        `${entitlement.amount}${entitlement.unit === undefined ? "" : ` ${entitlement.unit}`}`,
                        entitlement.period === "daily"
                          ? t("cliProxy.offerPeriodDaily")
                          : entitlement.period === "one_time"
                            ? t("cliProxy.offerPeriodOneTime")
                            : entitlement.period,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </li>
                  ))}
                </ul>
                {/* 阿里云验证码 SDK 要求真实的容器与触发按钮节点。 */}
                <div id={elementId} className={cn("mt-3", captchaReady ? "" : "hidden")} />
                <Button
                  id={buttonId}
                  type="button"
                  size="sm"
                  className="mt-3 w-full"
                  disabled={pending || !captchaReady}
                >
                  {pending ? t("cliProxy.claimPending") : t("cliProxy.offerClaim")}
                </Button>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("cliProxy.claimCaptchaFallback")}</p>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            size="sm"
            variant={result !== null && result.success ? "default" : "ghost-muted"}
            disabled={pending}
            onClick={onClose}
          >
            {result !== null && result.success ? t("cliProxy.claimDone") : t("cancel")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};
