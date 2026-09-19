/**
 * Application error carrying the HTTP status and stable machine code that the
 * final error handler serialises into the AppErrorBody envelope.
 * Services/routes signal all expected failures through AppError — never res.*,
 * never leaked internals.
 */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}
