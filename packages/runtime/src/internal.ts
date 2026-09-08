/**
 * Internals the CLI depends on. Not public API: anything here may change in a
 * minor release. Consumers wanting the rendered SQL should use
 * `TypedQuery.compile()`.
 */
export { parseSqlFile, type SqlFileParse } from './parse-sql-file.js';
export { parseTagged } from './parse-tagged.js';
export {
  render,
  ParameterTransform,
  type QueryParameters,
  type InterpolatedQuery,
  type QueryParameter,
} from './render.js';
export type {
  QueryIR,
  ParamIR,
  Transform,
  Key,
  ColumnHint,
  Diagnostic,
} from './ir.js';
