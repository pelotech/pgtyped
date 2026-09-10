export type Type =
  | NamedType
  | ImportedType
  | AliasedType
  | EnumType
  | EnumArrayType
  | DomainType;
// May be a database source type name (string) or a typescript destination type (Type)
export type MappableType = string | Type;

export interface NamedType {
  name: string;
  definition?: string;
  enumValues?: string[];
}

export interface ImportedType extends NamedType {
  from: string;
  aliasOf?: string;
}

export interface AliasedType extends NamedType {
  definition: string;
}

export interface EnumType extends NamedType {
  enumValues: string[];
}

export interface EnumArrayType extends NamedType {
  name: string;
  elementType: EnumType;
}

/**
 * A domain, carrying whatever its base type resolves to.
 *
 * Postgres reports a domain-typed *result* column as its base type in
 * RowDescription — never as the domain — so a `typesOverrides` entry naming a
 * domain silently never fired (#503, #594). The domain's own OID is recovered
 * from `pg_attribute.atttypid`, which means the name is available to the
 * mapping again; `baseType` is what the type still has to resolve to when
 * nothing overrides that name, so that an un-overridden domain generates
 * exactly what it generated before.
 */
export interface DomainType extends NamedType {
  name: string;
  baseType: MappableType;
}

export function isImport(typ: Type): typ is ImportedType {
  return 'from' in typ;
}

export function isAlias(typ: Type): typ is AliasedType {
  return 'definition' in typ;
}

export function isEnum(typ: MappableType): typ is EnumType {
  return typeof typ !== 'string' && 'enumValues' in typ;
}

export function isEnumArray(typ: MappableType): typ is EnumArrayType {
  return typeof typ !== 'string' && 'elementType' in typ;
}

export function isDomain(typ: MappableType): typ is DomainType {
  return typeof typ !== 'string' && 'baseType' in typ;
}

export const enum DatabaseTypeKind {
  Base = 'b',
  Composite = 'c',
  Domain = 'd',
  Enum = 'e',
  Pseudo = 'p',
  Range = 'r',
}
