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
