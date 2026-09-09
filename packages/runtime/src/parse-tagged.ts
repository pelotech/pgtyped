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
 * nullability hints; it is stripped from the statement. There is no `@name`
 * inside the template: a plain `sql` tag is named after the variable it is
 * assigned to by codegen and is never prepared, and a `sql.named` tag passes
 * its name in as `queryName`.
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
  // Drop a terminating semicolon, as the .sql front-end does when it splits on
  // one. Without this the two front-ends emit different text for the same
  // query, and a tag written with a trailing `;` sends it to the server where
  // 2.x did not. Only a real terminator goes: a `;` inside a string literal is
  // not at the end after trimming.
  statement = statement.replace(/;\s*$/, '').trimEnd();

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
