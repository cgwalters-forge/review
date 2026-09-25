// Shared test setup.

import { JSDOM } from "jsdom";

/** A fresh jsdom window, also installed as the global document. */
export function installDom(): JSDOM["window"] {
  const { window } = new JSDOM("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, { document: window.document, window });
  return window;
}
