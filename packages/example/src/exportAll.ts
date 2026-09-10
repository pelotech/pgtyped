/**
 * A barrel over every generated file, which is what issue #565 is about.
 *
 * Two generated files that both need `nullableCategoryArray` — or `Json`, or
 * an enum's string union — each used to declare their own copy of it, so
 * re-exporting both from one module was `TS2308: Module './a.js' has already
 * exported a member named 'Json'`. Nothing here imports this file; `tsc
 * --noEmit` over the package is what checks it.
 */
export * from './books/books.queries.js';
export * from './comments/comments.queries.js';
export * from './driverTypes/driverTypes.queries.js';
export * from './index.test.types.js';
export * from './notifications/notifications.queries.js';
export * from './notifications/notifications.types.js';
export * from './users/sample.types.js';
