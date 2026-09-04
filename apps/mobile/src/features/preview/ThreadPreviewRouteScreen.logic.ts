import type { PreviewControl } from "@codework/contracts";

export function controlInvalidatesScreenshot(control: PreviewControl): boolean {
  switch (control) {
    case "openDevTools":
    case "startRecording":
    case "stopRecording":
    case "openInSystemBrowser":
    case "openPictureInPicture":
    case "closePictureInPicture":
    case "clearCookies":
    case "clearCache":
      return false;
    default:
      return true;
  }
}
