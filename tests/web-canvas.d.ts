/**
 * Ambient types for the plain-JS canvas model (web/canvas/model.js).
 * Only the surface tests touch is declared — the port mirrors
 * shared/canvas/* but stays JS so the browser loads it without a build.
 */
declare module "*/web/canvas/model.js" {
  import type { CanvasBody } from "../../shared/canvas/schema.js";
  export function blankBody(): CanvasBody;
  export function buildXlsx(body: CanvasBody): Blob;
  export function sanitizeBody(
    input: unknown,
    warnings?: string[],
    trusted?: boolean,
  ): CanvasBody;
}
declare module "*/web/canvas/autosave.js" {
  export interface AutosaveDeps {
    debounceMs?: number;
    send: (body: unknown, opts?: { keepalive?: boolean }) => Promise<{ status: number }>;
    setState: (state: string) => void;
  }
  export function createAutosave(deps: AutosaveDeps): {
    schedule(bodyGetter?: () => unknown): void;
    flush(bodyGetter?: () => unknown, opts?: { keepalive?: boolean }): Promise<void>;
    retry(): Promise<void>;
    freeze(): void;
    thaw(): void;
    isFrozen(): boolean;
    dispose(): void;
  };
}
