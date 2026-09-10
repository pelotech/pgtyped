import { getTypes, IQueryTypes, TypeSource } from './db/types.js';
import type { TypeDb } from './db/type-db.js';
import {
  ParameterTransform,
  parseSqlFile,
  render,
  type Diagnostic,
  type QueryIR,
} from '@pelotech/pgtyped-runtime/internal';
import { camelCase, pascalCase } from 'change-case';
import path from 'path';
import { ParsedConfig, TransformConfig } from './config.js';
import { attachPreparedStatementName } from './preparedStatementName.js';
import { TypeAllocator, TypeDefinitions, TypeScope } from './types.js';

export interface IField {
  optional?: boolean;
  fieldName: string;
  fieldType: string;
  comment?: string;
}

const interfaceGen = (interfaceName: string, contents: string) =>
  `export interface ${interfaceName} {
${contents}
}\n\n`;

export function escapeComment(comment: string) {
  return comment.replace(/\*\//g, '*\\/');
}

/** Escape a key if it isn't an identifier literal */
export function escapeKey(key: string) {
  if (/^[a-zA-Z_$][a-zA-Z_$0-9]*$/.test(key)) {
    return key;
  }
  return `"${key}"`;
}

export const generateInterface = (interfaceName: string, fields: IField[]) => {
  const sortedFields = fields
    .slice()
    .sort((a, b) => a.fieldName.localeCompare(b.fieldName));
  const contents = sortedFields
    .map(({ fieldName, fieldType, comment, optional }) => {
      const lines = [];
      if (comment) {
        lines.push(`  /** ${escapeComment(comment)} */`);
      }
      const keySuffix = optional ? '?' : '';
      const entryLine = `  ${escapeKey(fieldName)}${keySuffix}: ${fieldType};`;
      lines.push(entryLine);
      return lines.join('\n');
    })
    .join('\n');
  return interfaceGen(interfaceName, contents);
};

export const generateTypeAlias = (typeName: string, alias: string) =>
  `export type ${typeName} = ${alias};\n\n`;

/**
 * A result column whose name ends in `!` or `?` is almost always 2.x syntax
 * that was never migrated: back then the suffix was stripped off every row
 * key at runtime, so `AS "total!"` read back as `row.total`. 3.0 leaves the
 * alias alone, which makes the column genuinely named `total!`.
 *
 * That is survivable on its own — the odd field name in the generated type
 * gives the game away. It is not survivable with `camelCaseColumnNames`:
 * `camelCase('total!')` is `'total'`, so the generated type promises a field
 * the rows do not have and `row.total` is silently `undefined`. Hence a
 * warning on the column name rather than on the config combination.
 */
function nullabilitySuffixWarning(
  returnName: string,
  queryName: string,
): string | undefined {
  const match = /^(.+)([!?])$/.exec(returnName);
  if (!match) {
    return undefined;
  }
  const [, alias, suffix] = match;
  return (
    `Column alias "${returnName}" in query '${queryName}' ends in a nullability suffix, ` +
    `which 3.0 reads from @column annotations instead — the column really is named "${returnName}". ` +
    `Rename the alias to "${alias}" and add \`@column ${alias}${suffix}\` to the query's comment block.`
  );
}

/**
 * Two result columns that land on the same generated field emit an interface
 * declaring the same key twice — TS2300, and the generated file does not
 * compile. There is no sensible way to merge two distinct columns onto one
 * name, so the query is reported as invalid rather than generated broken.
 *
 * `camelCaseColumnNames` can *create* the collision out of columns that were
 * distinct in SQL — `"userName"` and `user_name` both camelCase to `userName` —
 * so when the field is not simply the column name repeated, the message names
 * the source columns that collapsed onto it.
 *
 * It is also what keeps `@column` hints unambiguous. A hint is keyed by the
 * Postgres result column name, so a single `@column id!` matches *both* columns
 * of `SELECT a.id, b."aId" AS id` and silently applies to each; that query can
 * no longer generate at all, which is the only coherent answer — the hint says
 * nothing about which of the two it meant.
 */
function duplicateFieldErrors(
  returnTypes: IQueryTypes['returnTypes'],
  queryName: string,
  camelCaseColumnNames: boolean,
): string[] {
  const sources = new Map<string, string[]>();
  for (const { returnName } of returnTypes) {
    const field = camelCaseColumnNames ? camelCase(returnName) : returnName;
    sources.set(field, [...(sources.get(field) ?? []), returnName]);
  }
  const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(', ');
  return [...sources]
    .filter(([, columns]) => columns.length > 1)
    .map(([field, columns]) =>
      columns.every((column) => column === field)
        ? `Query '${queryName}' has ${columns.length} result columns named "${field}". ` +
          `A TypeScript interface cannot declare the same key twice, so no result type can be ` +
          `generated for it. Alias one of them to a different name.`
        : `Query '${queryName}' has ${columns.length} result columns that camelCaseColumnNames ` +
          `collapses onto the field "${field}": ${quoted(columns)}. ` +
          `A TypeScript interface cannot declare the same key twice, so no result type can be ` +
          `generated for it. Alias one of them to a name that does not collide, or turn ` +
          `camelCaseColumnNames off.`,
    );
}

export async function queryToTypeDeclarations(
  ir: QueryIR,
  fileName: string,
  typeSource: TypeSource,
  types: TypeAllocator,
  config: ParsedConfig,
): Promise<string> {
  const queryName = pascalCase(ir.queryName);
  const queryData = render(ir);

  // The allocator is shared by every query in the file and accumulates errors,
  // so this is where the ones belonging to *this* query start. Reporting the
  // whole array, as this used to, printed each error again for every query
  // that followed it in the file.
  const errorsBefore = types.errors.length;

  const typeData = await typeSource(queryData);
  const interfaceName = pascalCase(queryName);
  const interfacePrefix = config.hungarianNotation ? 'I' : '';

  const typeError = 'errorCode' in typeData;
  const hasAnonymousColumns =
    !typeError &&
    (typeData as IQueryTypes).returnTypes.some(
      ({ returnName }) => returnName === '?column?',
    );

  // Only asked once the columns are known to be describable and named: an
  // anonymous column is reported as itself, and every `?column?` would
  // otherwise be reported a second time as a collision.
  const duplicateFields =
    typeError || hasAnonymousColumns
      ? []
      : duplicateFieldErrors(
          (typeData as IQueryTypes).returnTypes,
          queryName,
          config.camelCaseColumnNames,
        );

  if (typeError || hasAnonymousColumns || duplicateFields.length > 0) {
    // tslint:disable:no-console
    if (typeError) {
      // Named, because on the default failOnError: false path this is the only
      // thing the user sees, and files are processed concurrently — the
      // interleaved `Processing …` lines cannot attribute it (#526, #584).
      console.error(
        'Error in query "%s" in %s. Details: %o',
        queryName,
        fileName,
        typeData,
      );
      if (config.failOnError) {
        throw new Error(
          `Query "${queryName}" is invalid. Can't generate types.`,
        );
      }
    } else if (hasAnonymousColumns) {
      console.error(
        `Query '${queryName}' is invalid. Query contains an anonymous column. Consider giving the column an explicit name.`,
      );
    } else {
      duplicateFields.forEach((message) => console.error(message));
      // Fatal under failOnError, like the type error above: the run wrote
      // `never` for a query it was asked to type, and that is a failure.
      if (config.failOnError) {
        throw new Error(duplicateFields.join('\n'));
      }
    }
    let explanation = '';
    if (hasAnonymousColumns) {
      explanation = `Query contains an anonymous column. Consider giving the column an explicit name.`;
    } else if (duplicateFields.length > 0) {
      explanation = duplicateFields.join(' ');
    }

    const returnInterface = generateTypeAlias(
      `${interfacePrefix}${interfaceName}Result`,
      'never',
    );
    const paramInterface = generateTypeAlias(
      `${interfacePrefix}${interfaceName}Params`,
      'never',
    );
    const resultErrorComment = `/** Query '${queryName}' is invalid, so its result is assigned type 'never'.\n * ${explanation} */\n`;
    const paramErrorComment = `/** Query '${queryName}' is invalid, so its parameters are assigned type 'never'.\n * ${explanation} */\n`;
    return `${resultErrorComment}${returnInterface}${paramErrorComment}${paramInterface}`;
  }

  const { returnTypes, paramMetadata } = typeData;

  const returnFieldTypes: IField[] = [];
  const paramFieldTypes: IField[] = [];

  // Emitted here rather than in either front-end parser so that both `sql`
  // files and `sql` tags surface it: this is the one place both modes pass
  // through, and it is the only place the server-reported column names are
  // known at all.
  const suffixWarnings = returnTypes
    .map(({ returnName }) => nullabilitySuffixWarning(returnName, queryName))
    .filter((warning): warning is string => warning !== undefined);
  // tslint:disable-next-line:no-console
  suffixWarnings.forEach((warning) => console.warn(warning));
  // Advisory by default — the types generated are an accurate description of
  // what the server returns — until failOnError asks for the strict reading,
  // exactly as the tag lints do.
  if (config.failOnError && suffixWarnings.length > 0) {
    throw new Error(suffixWarnings.join('\n'));
  }

  returnTypes.forEach(({ returnName, type, nullable, comment }) => {
    let tsTypeName = types.use(type, TypeScope.Return);

    // A `@column name!` / `@column name?` annotation overrides what the
    // catalog reports. Hints are keyed by the Postgres result column name, so
    // the lookup happens before camelCasing. Absent a hint, a column the
    // catalog cannot vouch for (`nullable` undefined) is treated as nullable.
    const hint = ir.columns.find((c) => c.name === returnName);
    if (hint ? hint.nullable : (nullable ?? true)) {
      tsTypeName += ' | null';
    }

    returnFieldTypes.push({
      fieldName: config.camelCaseColumnNames
        ? camelCase(returnName)
        : returnName,
      fieldType: tsTypeName,
      comment,
    });
  });

  const formatArrayType = (type: string): string => {
    if (config.nonEmptyArrayParams) {
      // Only allow accepting an non-empty array. This prevents runtime errors.
      // For example, the following query will throw a runtime error if an empty
      // array is passed:
      //   /*
      //     @name GetNotifications
      //     @param userIds -> (...)
      //   */
      //   SELECT * FROM notifications WHERE id in :userIds!
      // As the query at runtime becomes:
      //   SELECT * FROM notifications WHERE id in ()
      // Which is a syntax error for postgres.
      return `readonly [${type}, ...(${type})[]]`;
    }
    return `readonly (${type})[]`;
  };

  const { params } = paramMetadata;
  for (const param of paramMetadata.mapping) {
    if (
      param.type === ParameterTransform.Scalar ||
      param.type === ParameterTransform.Spread
    ) {
      const isArray = param.type === ParameterTransform.Spread;
      const assignedIndex =
        param.assignedIndex instanceof Array
          ? param.assignedIndex[0]
          : param.assignedIndex;
      const pgTypeName = params[assignedIndex - 1];
      let tsTypeName = types.use(pgTypeName, TypeScope.Parameter);

      if (!param.required) {
        tsTypeName += ' | null | void';
      }

      // Allow optional scalar parameters to be missing from parameters object
      const optional =
        param.type === ParameterTransform.Scalar && !param.required;

      paramFieldTypes.push({
        optional,
        fieldName: param.name,
        fieldType: isArray ? formatArrayType(tsTypeName) : tsTypeName,
      });
    } else {
      const isArray = param.type === ParameterTransform.PickSpread;
      let fieldType = Object.values(param.dict)
        .map((p) => {
          const paramType = types.use(
            params[p.assignedIndex - 1],
            TypeScope.Parameter,
          );
          // A key that was not marked `!` may be left out of the object
          // entirely, exactly as a non-required scalar param may be left out
          // of the params object — and for the same reason: `render` reads
          // the key off the object and binds whatever it finds, so an absent
          // key and an explicit `undefined` both reach the server as NULL.
          // Without the `?` the only way to omit an optional key was to spell
          // out `key: undefined` (#573).
          return p.required
            ? `    ${p.name}: ${paramType}`
            : `    ${p.name}?: ${paramType} | null | void`;
        })
        .join(',\n');
      fieldType = `{\n${fieldType}\n  }`;
      if (isArray) {
        fieldType = formatArrayType(fieldType);
      }
      paramFieldTypes.push({
        fieldName: param.name,
        fieldType,
      });
    }
  }

  // A type the mapping does not know is emitted as `unknown`, which is a real
  // signal: the caller has to narrow it before doing anything with it. The
  // comment that stood here claimed a `never` was emitted "which can be caught
  // later when compiling", and both halves were wrong — it emits `unknown`,
  // and `never` would be *weaker*, not stronger, because `never` is assignable
  // to every type, so `const total: number = row.row` would compile silently.
  // `unknown` stays; what was missing is that nothing escalated (#317).
  const newErrors = types.errors.slice(errorsBefore);
  // tslint:disable-next-line:no-console
  newErrors.forEach((err) => console.log(err));
  // Advisory by default, fatal under failOnError — the same rule the parser
  // warnings and the nullability-suffix warning above follow. `failOnError:
  // true` used to exit 0 on an unmapped type, which is the whole of #317's
  // second half: the run reported success and wrote `unknown` to disk.
  if (config.failOnError && newErrors.length > 0) {
    throw new Error(
      `Query "${queryName}" in ${fileName} uses types the mapping does not support:\n` +
        newErrors.map((err) => err.message).join('\n') +
        `\nAdd a "typesOverrides" entry for each, or remove the column from the query.`,
    );
  }

  const resultInterfaceName = `${interfacePrefix}${interfaceName}Result`;
  const returnTypesInterface =
    `/** '${queryName}' return type */\n` +
    (returnFieldTypes.length > 0
      ? generateInterface(
          `${interfacePrefix}${interfaceName}Result`,
          returnFieldTypes,
        )
      : generateTypeAlias(resultInterfaceName, 'void'));

  const paramInterfaceName = `${interfacePrefix}${interfaceName}Params`;
  const paramTypesInterface =
    `/** '${queryName}' parameters type */\n` +
    (paramFieldTypes.length > 0
      ? generateInterface(
          `${interfacePrefix}${interfaceName}Params`,
          paramFieldTypes,
        )
      : generateTypeAlias(paramInterfaceName, 'void'));

  const typePairInterface =
    `/** '${queryName}' query type */\n` +
    generateInterface(`${interfacePrefix}${interfaceName}Query`, [
      { fieldName: 'params', fieldType: paramInterfaceName },
      { fieldName: 'result', fieldType: resultInterfaceName },
    ]);

  return [paramTypesInterface, returnTypesInterface, typePairInterface].join(
    '',
  );
}

export type TSTypedQuery = {
  mode: 'ts';
  fileName: string;
  query: {
    name: string;
    queryTypeAlias: string;
  };
  typeDeclaration: string;
};

type SQLTypedQuery = {
  mode: 'sql';
  fileName: string;
  query: {
    name: string;
    ir: QueryIR;
    paramTypeAlias: string;
    returnTypeAlias: string;
  };
  typeDeclaration: string;
};

export type GeneratedQueryDec = TSTypedQuery | SQLTypedQuery;
export type TypeDeclarationSet = {
  typedQueries: GeneratedQueryDec[];
  typeDefinitions: TypeDefinitions;
  fileName: string;
};
/**
 * `typescript` is an optional peer dependency: only `ts` transforms need it, so
 * the parser (and with it the whole compiler) is loaded on demand.
 */
async function loadTypescriptParser(): Promise<
  typeof import('./parseTypescript.js')
> {
  try {
    return await import('./parseTypescript.js');
  } catch (err) {
    throw new Error(
      'Transform mode "ts" needs the optional peer dependency "typescript" (>=5 <7). Install it to generate types from sql tags.',
      { cause: err },
    );
  }
}

export async function generateTypedecsFromFile(
  contents: string,
  fileName: string,
  db: TypeDb,
  transform: TransformConfig,
  types: TypeAllocator,
  config: ParsedConfig,
): Promise<TypeDeclarationSet> {
  const typedQueries: GeneratedQueryDec[] = [];
  const interfacePrefix = config.hungarianNotation ? 'I' : '';
  const typeSource: TypeSource = (query) => getTypes(query, db);

  const done = () => ({
    typedQueries,
    typeDefinitions: types.toTypeDefinitions(),
    fileName,
  });

  let queries: QueryIR[];
  if (transform.mode === 'sql') {
    const parsed = parseSqlFile(contents);
    const located = ({ message, offset }: Diagnostic) =>
      `${fileName}: ${message} (offset ${offset})`;
    for (const warning of parsed.warnings) {
      console.warn(located(warning));
    }
    for (const error of parsed.errors) {
      console.error(located(error));
    }
    // Errors are fatal: a query whose annotation could not be read still
    // parses, into precisely the wrong SQL, so nothing here may be used.
    if (parsed.errors.length > 0) {
      return done();
    }
    // A warning still generates correct types, so it is only advisory — until
    // failOnError, which is how a project asks for the stricter reading. The
    // same rule as the `ts` branch below: one option, one meaning, whichever
    // kind of file the query lives in.
    if (config.failOnError && parsed.warnings.length > 0) {
      throw new Error(parsed.warnings.map(located).join('\n'));
    }
    queries = parsed.queries;
  } else {
    const parsed = (await loadTypescriptParser()).parseCode(
      contents,
      fileName,
      interfacePrefix,
    );
    for (const message of parsed.warnings) {
      console.warn(message);
    }
    if (parsed.errors.length > 0) {
      for (const message of parsed.errors) {
        console.error(message);
      }
      return done();
    }
    // A warning still generates correct types, so it is only advisory — until
    // failOnError, which is how a project asks for the stricter reading.
    if (config.failOnError && parsed.warnings.length > 0) {
      throw new Error(parsed.warnings.join('\n'));
    }
    queries = parsed.queries;
  }

  for (const ir of queries) {
    const typeDeclaration = await queryToTypeDeclarations(
      ir,
      fileName,
      typeSource,
      types,
      config,
    );
    const prefixed = `${interfacePrefix}${pascalCase(ir.queryName)}`;
    typedQueries.push(
      transform.mode === 'sql'
        ? {
            mode: 'sql',
            fileName,
            query: {
              name: camelCase(ir.queryName),
              ir: attachPreparedStatementName(ir, config),
              paramTypeAlias: `${prefixed}Params`,
              returnTypeAlias: `${prefixed}Result`,
            },
            typeDeclaration,
          }
        : {
            mode: 'ts',
            fileName,
            query: {
              name: ir.queryName,
              queryTypeAlias: `${prefixed}Query`,
            },
            typeDeclaration,
          },
    );
  }
  return done();
}

export function generateDeclarations(typeDecs: GeneratedQueryDec[]): string {
  let typeDeclarations = '';
  for (const typeDec of typeDecs) {
    typeDeclarations += typeDec.typeDeclaration;
    if (typeDec.mode === 'ts') {
      continue;
    }
    const queryPP = typeDec.query.ir.statement
      .split('\n')
      // A block comment in the SQL would otherwise close this doc comment
      // early and leave the rest of the file unparseable.
      .map((s: string) => ' * ' + s.replace(/\*\//g, '*\\/'))
      .join('\n');
    typeDeclarations += `const ${typeDec.query.name}IR: any = ${JSON.stringify(
      typeDec.query.ir,
    )};\n\n`;
    typeDeclarations +=
      `/**\n` +
      ` * Query generated from SQL:\n` +
      ` * \`\`\`\n` +
      `${queryPP}\n` +
      ` * \`\`\`\n` +
      ` */\n`;
    typeDeclarations +=
      `export const ${typeDec.query.name} = ` +
      `new TypedQuery<${typeDec.query.paramTypeAlias},${typeDec.query.returnTypeAlias}>` +
      `(${typeDec.query.name}IR);\n\n\n`;
  }
  return typeDeclarations;
}

export function generateDeclarationFile(typeDecSet: TypeDeclarationSet) {
  // file paths in generated files must be stable across platforms
  // https://github.com/adelsz/pgtyped/issues/230
  const isWindowsPath = path.sep === '\\';
  // always emit POSIX paths
  const stableFilePath = isWindowsPath
    ? typeDecSet.fileName.replace(/\\/g, '/')
    : typeDecSet.fileName;

  let content = `/** Types generated for queries found in "${stableFilePath}" */\n`;
  content += TypeAllocator.typeDefinitionDeclarations(
    typeDecSet.fileName,
    typeDecSet.typeDefinitions,
  );
  content += '\n';
  content += generateDeclarations(typeDecSet.typedQueries);
  return content;
}
