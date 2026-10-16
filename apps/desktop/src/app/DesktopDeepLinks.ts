import * as Electron from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { DEEP_LINK_CHANNEL } from "../ipc/channels.ts";

/**
 * Deep links the OS hands to Code Work (`codework://…`, and the dev/preview
 * and legacy scheme aliases). A link can arrive before the web app loads
 * (it launched the app) or while it reloads, so links queue until the
 * renderer says it is listening, and revealing the window waits for the
 * same moment so the landing state is what the user sees.
 */
export class DesktopDeepLinks extends Context.Service<
  DesktopDeepLinks,
  {
    /** Queues a link and delivers it as soon as the renderer is listening. */
    readonly receive: (url: string) => Effect.Effect<void>;
    /** The renderer started or restarted listening; listening flushes queued links. */
    readonly setRendererReady: Effect.Effect<void>;
  }
>()("@codework/desktop/app/DesktopDeepLinks") {}

const make = Effect.gen(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const pending: Array<string> = [];
  /** The page that said it is listening; a reload or crash replaces it, and it must say so again. */
  let listening: Electron.WebContents | null = null;
  let detachListening: (() => void) | null = null;

  const stopListening = () => {
    detachListening?.();
    detachListening = null;
    listening = null;
  };

  const flush = Effect.gen(function* () {
    if (listening === null || pending.length === 0) return;
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window) || window.value.webContents !== listening) return;
    if (listening.isDestroyed()) {
      stopListening();
      return;
    }
    for (const url of pending.splice(0)) listening.send(DEEP_LINK_CHANNEL, url);
    yield* electronWindow.reveal(window.value);
  });

  const receive = (url: string) =>
    Effect.gen(function* () {
      pending.push(url);
      yield* flush;
    });

  const setRendererReady = Effect.gen(function* () {
    const window = yield* electronWindow.currentMainOrFirst;
    if (Option.isNone(window) || window.value.webContents.isDestroyed()) return;
    const webContents = window.value.webContents;
    if (listening !== webContents) {
      stopListening();
      listening = webContents;
      // Links that arrive while a new page loads wait for it to listen again.
      const onNavigation = (
        event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
      ) => {
        if (event.isMainFrame && !event.isSameDocument) stopListening();
      };
      webContents.on("did-start-navigation", onNavigation);
      webContents.on("render-process-gone", stopListening);
      webContents.once("destroyed", stopListening);
      detachListening = () => {
        webContents.removeListener("did-start-navigation", onNavigation);
        webContents.removeListener("render-process-gone", stopListening);
        webContents.removeListener("destroyed", stopListening);
      };
    }
    yield* flush;
  });

  return DesktopDeepLinks.of({ receive, setRendererReady });
});

export const layer = Layer.effect(DesktopDeepLinks, make);
