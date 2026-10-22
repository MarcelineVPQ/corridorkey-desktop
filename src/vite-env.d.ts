/// <reference types="vite/client" />
import type { CorridorKeyApi } from "./shared/types";

declare global {
  interface Window {
    ck: CorridorKeyApi;
  }
}
