import type { FileManagerApi } from "../../electron/preload";

declare global {
  interface Window {
    fileManager: FileManagerApi;
  }
}

export {};

