import { t } from "~/i18n";
export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label={t("codeWorkSplashScreen")}
      >
        {/* ?v= 与 index.html 的图标世代号保持一致，避免长缓存下的旧图标 */}
        <img alt="Code Work" className="size-16 object-contain" src="/apple-touch-icon.png?v=26" />
      </div>
    </div>
  );
}
