/**
 * Ambient types for the plain-JS canvas model (web/canvas/model.js).
 * Only the surface tests touch is declared — the port mirrors
 * shared/canvas/* but stays JS so the browser loads it without a build.
 */
declare module "*/web/canvas/model.js" {
  import type { CanvasBody } from "../../shared/canvas/schema.js";
  export function blankBody(): CanvasBody;
  export function buildXlsx(body: CanvasBody): Blob;
}
