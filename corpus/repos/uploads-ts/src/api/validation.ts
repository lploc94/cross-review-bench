import type { z } from "zod";

/**
 * Parse a request part with its schema. A failure throws the ZodError, which the error handler
 * reports as a 400 with one detail per issue, prefixed with where the value came from.
 */
export function parse<S extends z.ZodType>(
  schema: S,
  value: unknown,
  source: RequestPart,
): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new RequestValidationError(source, result.error);
  }
  return result.data;
}

export type RequestPart = "body" | "query" | "params" | "headers";

export class RequestValidationError extends Error {
  readonly source: RequestPart;
  readonly zodError: z.ZodError;

  constructor(source: RequestPart, zodError: z.ZodError) {
    super(`invalid request ${source}`);
    this.name = "RequestValidationError";
    this.source = source;
    this.zodError = zodError;
  }

  get issues(): { path: string; message: string }[] {
    return this.zodError.issues.map((issue) => ({
      path: [this.source, ...issue.path.map(String)].join("."),
      message: issue.message,
    }));
  }
}
