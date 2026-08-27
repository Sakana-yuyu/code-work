import { t } from "~/i18n";
export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div
        className="flex size-24 items-center justify-center"
        aria-label={t("codeWorkSplashScreen")}
      >
        <img alt="Code Work" className="size-16 object-contain" src="/apple-touch-icon.png" />
      </div>
    </div>
  );
}
