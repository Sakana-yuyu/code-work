import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopDeepLinks from "../../app/DesktopDeepLinks.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import { DEEP_LINK_READY_CHANNEL } from "../channels.ts";

/**
 * The renderer reports it is ready to receive deep links; queued links
 * (the one that launched the app, or any received during a reload) flush.
 */
export const setDeepLinkReady = DesktopIpc.makeIpcMethod({
  channel: DEEP_LINK_READY_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.deepLinks.ready")(function* () {
    const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
    yield* deepLinks.setRendererReady;
  }),
});
