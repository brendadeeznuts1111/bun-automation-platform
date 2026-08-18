// Type-safe route module helper.
//
// Bun.serve()'s `routes` property infers route params from string literal
// keys (e.g. "/task/:id" → req.params.id: string). When routes are defined
// in separate files and spread into the routes object, TypeScript loses
// that inference. This helper preserves it.
//
// Ref: https://github.com/oven-sh/bun/issues/23182
// Ref: https://bun.com/docs/runtime/http/routing

import type { Serve } from "bun";

/**
 * Identity function that preserves the type of a routes object so that
 * `BunRequest<T>` param inference works when routes are spread into
 * `Bun.serve({ routes: { ...moduleRoutes } })`.
 */
export function router<W, R extends string>(routes: Serve.Routes<W, R>): Serve.Routes<W, R> {
  return routes;
}
