import type { SQLQueryIR } from '@pelotech/pgtyped-parser';
import { processSQLQueryIR } from './preprocessor-sql.js';
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
    this.hasParams = ir.params.some((p) => p.name in ir.usedParamSet);
  }

  protected interpolate(params: TParams): Interpolated {
    const { query: text, bindings: values } = processSQLQueryIR(
      this.ir,
      params as never,
    );
    return { text, values };
  }
}
