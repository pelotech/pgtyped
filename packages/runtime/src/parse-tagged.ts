// packages/runtime/src/parse-tagged.ts
import type { ColumnHint, ParamIR, QueryIR, Transform } from './ir.js';
import { scanParams, type ParamRef } from './scanner.js';

function transformOf(ref: ParamRef): Transform {
  if (ref.keys)
    return ref.spread
      ? { type: 'pick_array_spread', keys: ref.keys }
      : { type: 'pick_tuple', keys: ref.keys };
  return ref.spread ? { type: 'array_spread' } : { type: 'scalar' };
}

/**
 * Parses the text of a `sql` tagged template. Params are inline (`$name`,
 * `$$name`, `$name(a, b!)`). A leading block comment may supply `@column`
 * nullability hints; it is stripped from the statement. There is no `@name`:
 * codegen names tagged queries after the variable they are assigned to, and at
 * runtime the name is irrelevant because tags are never prepared.
 */
export function parseTagged(text: string, queryName = 'query'): QueryIR {
  let statement = text.trim();
  const columns: ColumnHint[] = [];
  const lead = /^\/\*([\s\S]*?)\*\//.exec(statement);
  if (lead) {
    for (const m of lead[1].matchAll(
      /@column\s+([A-Za-z_][A-Za-z0-9_]*)([!?])/g,
    )) {
      columns.push({ name: m[1], nullable: m[2] === '?' });
    }
    statement = statement.slice(lead[0].length).trim();
  }

  const byName = new Map<string, ParamIR>();
  for (const ref of scanParams(statement, '$')) {
    const t = transformOf(ref);
    const existing = byName.get(ref.name);
    if (existing) {
      if (JSON.stringify(existing.transform) !== JSON.stringify(t)) {
        throw new Error(
          `Parameter "${ref.name}" is used with different selections`,
        );
      }
      existing.locs.push({ a: ref.a, b: ref.b });
      existing.required ||= ref.required;
    } else {
      byName.set(ref.name, {
        name: ref.name,
        transform: t,
        required: ref.required,
        locs: [{ a: ref.a, b: ref.b }],
      });
    }
  }
  return { queryName, statement, params: [...byName.values()], columns };
}
