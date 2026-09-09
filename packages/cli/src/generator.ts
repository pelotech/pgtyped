import { getTypes, IQueryTypes, TypeSource } from './db/types.js';
import type { TypeDb } from './db/type-db.js';
import {
  ParameterTransform,
  parseSqlFile,
  render,
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

export async function queryToTypeDeclarations(
  ir: QueryIR,
  typeSource: TypeSource,
  types: TypeAllocator,
  config: ParsedConfig,
): Promise<string> {
  const queryName = pascalCase(ir.queryName);
  const queryData = render(ir);

  const typeData = await typeSource(queryData);
  const interfaceName = pascalCase(queryName);
  const interfacePrefix = config.hungarianNotation ? 'I' : '';

  const typeError = 'errorCode' in typeData;
  const hasAnonymousColumns =
    !typeError &&
    (typeData as IQueryTypes).returnTypes.some(
      ({ returnName }) => returnName === '?column?',
    );

  if (typeError || hasAnonymousColumns) {
    // tslint:disable:no-console
    if (typeError) {
      console.error('Error in query. Details: %o', typeData);
      if (config.failOnError) {
        throw new Error(
          `Query "${queryName}" is invalid. Can't generate types.`,
        );
      }
    } else {
      console.error(
        `Query '${queryName}' is invalid. Query contains an anonymous column. Consider giving the column an explicit name.`,
      );
    }
    let explanation = '';
    if (hasAnonymousColumns) {
      explanation = `Query contains an anonymous column. Consider giving the column an explicit name.`;
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
          return p.required
            ? `    ${p.name}: ${paramType}`
            : `    ${p.name}: ${paramType} | null | void`;
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

  // TypeAllocator errors are currently considered non-fatal since a `never`
  // type is emitted which can be caught later when compiling the generated
  // code
  // tslint:disable-next-line:no-console
  types.errors.forEach((err) => console.log(err));

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
    for (const { message, offset } of parsed.warnings) {
      console.warn(`${fileName}: ${message} (offset ${offset})`);
    }
    for (const { message, offset } of parsed.errors) {
      console.error(`${fileName}: ${message} (offset ${offset})`);
    }
    // Errors are fatal: a query whose annotation could not be read still
    // parses, into precisely the wrong SQL, so nothing here may be used.
    if (parsed.errors.length > 0) {
      return done();
    }
    queries = parsed.queries;
  } else {
    const parsed = (await loadTypescriptParser()).parseCode(contents, fileName);
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
