/**
 * Minimal browser-global typings for e2e specs that run `page.evaluate`
 * inside Chromium — the callback executes against the page's DOM, not
 * Node. The project tsconfig intentionally stays on lib:["ES2023"] so
 * server code never sees DOM globals; only the names e2e specs touch are
 * declared here (`Event`/`localStorage` already exist via @types/node).
 */
declare const window: {
  dispatchEvent(event: Event): boolean;
  [key: string]: unknown;
};
