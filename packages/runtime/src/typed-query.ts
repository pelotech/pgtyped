import type { SQLQueryIR } from '@pelotech/pgtyped-parser';
import { processSQLQueryIR, usedParams } from './preprocessor-sql.js';
import type { QueryParameters } from './preprocessor.js';
import { Query, type Interpolated } from './query.js';

/**
 * A query from a .sql file. Codegen emits one of these per `@name` block,
 * carrying the parsed IR and, when prepared statements are enabled and the
 * query renders a fixed SQL text, a canonical statement name.
 */
export class TypedQuery<TParams, TResult> extends Query<TParams, TResult> {
  readonly name: string | undefined;
  protected readonly hasParams: boolean;

  constructor(private readonly ir: SQLQueryIR) {
    super();
    this.name = ir.name;
    // Same rule codegen applies when deciding whether to emit `Params = void`:
    // only params that are actually referenced in the statement count.
    this.hasParams = usedParams(ir).length > 0;
  }

  protected interpolate(params: TParams): Interpolated {
    // TParams is unconstrained on purpose: constraining it to QueryParameters
    // would reject generated params types, whose values include booleans,
    // Dates and JSON that QueryParameters' Scalar (string | number | null)
    // does not name. Assert to the callee's own type so a change to its
    // signature still surfaces here. Includes undefined: on the no-params path
    // the base passes undefined through, which processSQLQueryIR accepts as
    // "no bindings".
    const { query: text, bindings: values } = processSQLQueryIR(
      this.ir,
      params as QueryParameters | undefined,
    );
    return { text, values };
  }
}
