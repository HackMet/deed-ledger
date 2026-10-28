// Stands in for @eshaz/web-worker in the Worker bundle (see "alias" in wrangler.jsonc). opus-decoder
// imports it for its Web Worker variant, which we never use, and its browser build reads the global
// `Worker` at import time; workerd has none, so the script would fail at startup.
export default class WebWorkersUnavailable {
  constructor() {
    throw new Error("Web Workers are not available in Cloudflare Workers");
  }
}
