import debugBase from 'debug';
export const debug = debugBase('pg-typegen');

/**
 * How many files codegen works on at once, and how many connections the pool
 * keeps open for them. Codegen is bound on database round-trips, not CPU, so
 * this is a connection budget rather than a thread count.
 */
export const MAX_CONCURRENCY = 4;

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) {
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}

/**
 * The human-readable detail of a thrown value, if it has any. Errors carry a
 * message; anything else is stringified, since a CLI that prints
 * "[object Object]" tells the user less than nothing.
 */
export function errorDetail(cause: unknown): string | undefined {
  if (cause === undefined || cause === null) {
    return undefined;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  return detail.length > 0 ? detail : undefined;
}

/**
 * Reports a fatal error where a human will see it and exits non-zero.
 *
 * Every failure path in the CLI goes through here. Failures used to print to
 * stdout (or to a debug log that only appears with DEBUG set) and exit 0, so
 * CI treated a config typo or an unreachable database as a successful run.
 */
export function fatal(message: string, cause?: unknown): never {
  // tslint:disable:no-console
  console.error(message);
  const detail = errorDetail(cause);
  if (detail !== undefined) {
    console.error(detail);
  }
  return process.exit(1);
}
