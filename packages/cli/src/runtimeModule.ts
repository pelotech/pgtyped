/**
 * Module specifier emitted into generated files.
 *
 * Generated code imports `TypedQuery` and `sql` from here as *values*, which
 * is why it is the one import the declaration emitter does not mark type-only.
 * Renaming the runtime package means changing this constant and regenerating
 * every consumer's `.queries.ts`.
 */
export const RUNTIME_MODULE = '@pelotech/pgtyped-runtime';
