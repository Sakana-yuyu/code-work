/// <reference types="vite/client" />

import type { NativeApi } from "@acme/contracts";

declare global {
  interface Window {
    nativeApi?: NativeApi;
  }
}
