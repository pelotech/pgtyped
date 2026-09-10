/** Types generated for queries found in "src/books/books.sql" */
import { TypedQuery } from '@pelotech/pgtyped-runtime';

import type { Category } from '../customTypes.js';

export type Iso31661Alpha2 = 'AD' | 'AE' | 'AF' | 'AG' | 'AI' | 'AL' | 'AM' | 'AO' | 'AQ' | 'AR' | 'AS' | 'AT' | 'AU' | 'AW' | 'AX' | 'AZ' | 'BA' | 'BB' | 'BD' | 'BE' | 'BF' | 'BG' | 'BH' | 'BI' | 'BJ' | 'BL' | 'BM' | 'BN' | 'BO' | 'BQ' | 'BR' | 'BS' | 'BT' | 'BV' | 'BW' | 'BY' | 'BZ' | 'CA' | 'CC' | 'CD' | 'CF' | 'CG' | 'CH' | 'CI' | 'CK' | 'CL' | 'CM' | 'CN' | 'CO' | 'CR' | 'CU' | 'CV' | 'CW' | 'CX' | 'CY' | 'CZ' | 'DE' | 'DJ' | 'DK' | 'DM' | 'DO' | 'DZ' | 'EC' | 'EE' | 'EG' | 'EH' | 'ER' | 'ES' | 'ET' | 'FI' | 'FJ' | 'FK' | 'FM' | 'FO' | 'FR' | 'GA' | 'GB' | 'GD' | 'GE' | 'GF' | 'GG' | 'GH' | 'GI' | 'GL' | 'GM' | 'GN' | 'GP' | 'GQ' | 'GR' | 'GS' | 'GT' | 'GU' | 'GW' | 'GY' | 'HK' | 'HM' | 'HN' | 'HR' | 'HT' | 'HU' | 'ID' | 'IE' | 'IL' | 'IM' | 'IN' | 'IO' | 'IQ' | 'IR' | 'IS' | 'IT' | 'JE' | 'JM' | 'JO' | 'JP' | 'KE' | 'KG' | 'KH' | 'KI' | 'KM' | 'KN' | 'KP' | 'KR' | 'KW' | 'KY' | 'KZ' | 'LA' | 'LB' | 'LC' | 'LI' | 'LK' | 'LR' | 'LS' | 'LT' | 'LU' | 'LV' | 'LY' | 'MA' | 'MC' | 'MD' | 'ME' | 'MF' | 'MG' | 'MH' | 'MK' | 'ML' | 'MM' | 'MN' | 'MO' | 'MP' | 'MQ' | 'MR' | 'MS' | 'MT' | 'MU' | 'MV' | 'MW' | 'MX' | 'MY' | 'MZ' | 'NA' | 'NC' | 'NE' | 'NF' | 'NG' | 'NI' | 'NL' | 'NO' | 'NP' | 'NR' | 'NU' | 'NZ' | 'OM' | 'PA' | 'PE' | 'PF' | 'PG' | 'PH' | 'PK' | 'PL' | 'PM' | 'PN' | 'PR' | 'PS' | 'PT' | 'PW' | 'PY' | 'QA' | 'RE' | 'RO' | 'RS' | 'RU' | 'RW' | 'SA' | 'SB' | 'SC' | 'SD' | 'SE' | 'SG' | 'SH' | 'SI' | 'SJ' | 'SK' | 'SL' | 'SM' | 'SN' | 'SO' | 'SR' | 'SS' | 'ST' | 'SV' | 'SX' | 'SY' | 'SZ' | 'TC' | 'TD' | 'TF' | 'TG' | 'TH' | 'TJ' | 'TK' | 'TL' | 'TM';

export type category = 'novel' | 'science-fiction' | 'thriller';

export type categoryArray = (category)[];

export type nullableCategoryArray = (Category | null)[];

export type nullableStringArray = (string | null)[];

export type numberArray = (number)[];

/** 'FindBookById' parameters type */
export interface FindBookByIdParams {
  id?: number | null | void;
}

/** 'FindBookById' return type */
export interface FindBookByIdResult {
  author_id: number | null;
  categories: nullableCategoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookById' query type */
export interface FindBookByIdQuery {
  params: FindBookByIdParams;
  result: FindBookByIdResult;
}

const findBookByIdIR: any = {"queryName":"FindBookById","statement":"SELECT * FROM books WHERE id = :id","params":[{"name":"id","transform":{"type":"scalar"},"required":false,"locs":[{"a":31,"b":34}]}],"columns":[],"name":"FindBookById_ddfa9eb1"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM books WHERE id = :id
 * ```
 */
export const findBookById = new TypedQuery<FindBookByIdParams,FindBookByIdResult>(findBookByIdIR);


/** 'FindBookByCategory' parameters type */
export interface FindBookByCategoryParams {
  category?: category | null | void;
}

/** 'FindBookByCategory' return type */
export interface FindBookByCategoryResult {
  author_id: number | null;
  categories: nullableCategoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookByCategory' query type */
export interface FindBookByCategoryQuery {
  params: FindBookByCategoryParams;
  result: FindBookByCategoryResult;
}

const findBookByCategoryIR: any = {"queryName":"FindBookByCategory","statement":"SELECT * FROM books WHERE :category = ANY(categories)","params":[{"name":"category","transform":{"type":"scalar"},"required":false,"locs":[{"a":26,"b":35}]}],"columns":[],"name":"FindBookByCategory_3c5a2356"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM books WHERE :category = ANY(categories)
 * ```
 */
export const findBookByCategory = new TypedQuery<FindBookByCategoryParams,FindBookByCategoryResult>(findBookByCategoryIR);


/** 'FindBookNameOrRank' parameters type */
export interface FindBookNameOrRankParams {
  name?: string | null | void;
  rank?: number | null | void;
}

/** 'FindBookNameOrRank' return type */
export interface FindBookNameOrRankResult {
  id: number;
  name: string | null;
}

/** 'FindBookNameOrRank' query type */
export interface FindBookNameOrRankQuery {
  params: FindBookNameOrRankParams;
  result: FindBookNameOrRankResult;
}

const findBookNameOrRankIR: any = {"queryName":"FindBookNameOrRank","statement":"SELECT id, name\nFROM books\nWHERE (name = :name OR rank = :rank)","params":[{"name":"name","transform":{"type":"scalar"},"required":false,"locs":[{"a":41,"b":46}]},{"name":"rank","transform":{"type":"scalar"},"required":false,"locs":[{"a":57,"b":62}]}],"columns":[],"name":"FindBookNameOrRank_e90a7d76"};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, name
 * FROM books
 * WHERE (name = :name OR rank = :rank)
 * ```
 */
export const findBookNameOrRank = new TypedQuery<FindBookNameOrRankParams,FindBookNameOrRankResult>(findBookNameOrRankIR);


/** 'FindBookUnicode' parameters type */
export type FindBookUnicodeParams = void;

/** 'FindBookUnicode' return type */
export interface FindBookUnicodeResult {
  author_id: number | null;
  categories: nullableCategoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookUnicode' query type */
export interface FindBookUnicodeQuery {
  params: FindBookUnicodeParams;
  result: FindBookUnicodeResult;
}

const findBookUnicodeIR: any = {"queryName":"FindBookUnicode","statement":"SELECT * FROM books WHERE name = 'שקל'","params":[],"columns":[],"name":"FindBookUnicode_017a9bb5"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM books WHERE name = 'שקל'
 * ```
 */
export const findBookUnicode = new TypedQuery<FindBookUnicodeParams,FindBookUnicodeResult>(findBookUnicodeIR);


/** 'InsertBooks' parameters type */
export interface InsertBooksParams {
  books: readonly ({
    rank: number,
    name: string,
    authorId: number,
    categories?: categoryArray | null | void
  })[];
}

/** 'InsertBooks' return type */
export interface InsertBooksResult {
  book_id: number;
}

/** 'InsertBooks' query type */
export interface InsertBooksQuery {
  params: InsertBooksParams;
  result: InsertBooksResult;
}

const insertBooksIR: any = {"queryName":"InsertBooks","statement":"INSERT INTO books (rank, name, author_id, categories)\nVALUES :books RETURNING id as book_id","params":[{"name":"books","transform":{"type":"pick_array_spread","keys":[{"name":"rank","required":true},{"name":"name","required":true},{"name":"authorId","required":true},{"name":"categories","required":false}]},"required":false,"locs":[{"a":61,"b":67}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO books (rank, name, author_id, categories)
 * VALUES :books RETURNING id as book_id
 * ```
 */
export const insertBooks = new TypedQuery<InsertBooksParams,InsertBooksResult>(insertBooksIR);


/** 'UpdateBooksCustom' parameters type */
export interface UpdateBooksCustomParams {
  id: number;
  rank?: number | null | void;
}

/** 'UpdateBooksCustom' return type */
export type UpdateBooksCustomResult = void;

/** 'UpdateBooksCustom' query type */
export interface UpdateBooksCustomQuery {
  params: UpdateBooksCustomParams;
  result: UpdateBooksCustomResult;
}

const updateBooksCustomIR: any = {"queryName":"UpdateBooksCustom","statement":"UPDATE books\nSET\n    rank = (\n        CASE WHEN (:rank::int IS NOT NULL)\n                 THEN :rank\n             ELSE rank\n            END\n        )\nWHERE id = :id!","params":[{"name":"rank","transform":{"type":"scalar"},"required":false,"locs":[{"a":49,"b":54},{"a":95,"b":100}]},{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":161,"b":165}]}],"columns":[],"name":"UpdateBooksCustom_909552dd"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE books
 * SET
 *     rank = (
 *         CASE WHEN (:rank::int IS NOT NULL)
 *                  THEN :rank
 *              ELSE rank
 *             END
 *         )
 * WHERE id = :id!
 * ```
 */
export const updateBooksCustom = new TypedQuery<UpdateBooksCustomParams,UpdateBooksCustomResult>(updateBooksCustomIR);


/** 'UpdateBooks' parameters type */
export interface UpdateBooksParams {
  id: number;
  name?: string | null | void;
  rank?: number | null | void;
}

/** 'UpdateBooks' return type */
export type UpdateBooksResult = void;

/** 'UpdateBooks' query type */
export interface UpdateBooksQuery {
  params: UpdateBooksParams;
  result: UpdateBooksResult;
}

const updateBooksIR: any = {"queryName":"UpdateBooks","statement":"UPDATE books\n/* ignored comment */\nSET\n    name = :name,\n    rank = :rank\nWHERE id = :id!","params":[{"name":"name","transform":{"type":"scalar"},"required":false,"locs":[{"a":50,"b":55}]},{"name":"rank","transform":{"type":"scalar"},"required":false,"locs":[{"a":68,"b":73}]},{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":85,"b":89}]}],"columns":[],"name":"UpdateBooks_1ac11860"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE books
 * /* ignored comment *\/
 * SET
 *     name = :name,
 *     rank = :rank
 * WHERE id = :id!
 * ```
 */
export const updateBooks = new TypedQuery<UpdateBooksParams,UpdateBooksResult>(updateBooksIR);


/** 'UpdateBooksRankNotNull' parameters type */
export interface UpdateBooksRankNotNullParams {
  id: number;
  name?: string | null | void;
  rank: number;
}

/** 'UpdateBooksRankNotNull' return type */
export type UpdateBooksRankNotNullResult = void;

/** 'UpdateBooksRankNotNull' query type */
export interface UpdateBooksRankNotNullQuery {
  params: UpdateBooksRankNotNullParams;
  result: UpdateBooksRankNotNullResult;
}

const updateBooksRankNotNullIR: any = {"queryName":"UpdateBooksRankNotNull","statement":"UPDATE books\nSET\n    rank = :rank!,\n    name = :name\nWHERE id = :id!","params":[{"name":"rank","transform":{"type":"scalar"},"required":true,"locs":[{"a":28,"b":34}]},{"name":"name","transform":{"type":"scalar"},"required":false,"locs":[{"a":47,"b":52}]},{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":64,"b":68}]}],"columns":[],"name":"UpdateBooksRankNotNull_90468f52"};

/**
 * Query generated from SQL:
 * ```
 * UPDATE books
 * SET
 *     rank = :rank!,
 *     name = :name
 * WHERE id = :id!
 * ```
 */
export const updateBooksRankNotNull = new TypedQuery<UpdateBooksRankNotNullParams,UpdateBooksRankNotNullResult>(updateBooksRankNotNullIR);


/** 'GetBooksByAuthorName' parameters type */
export interface GetBooksByAuthorNameParams {
  authorName: string;
}

/** 'GetBooksByAuthorName' return type */
export interface GetBooksByAuthorNameResult {
  author_id: number | null;
  categories: nullableCategoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'GetBooksByAuthorName' query type */
export interface GetBooksByAuthorNameQuery {
  params: GetBooksByAuthorNameParams;
  result: GetBooksByAuthorNameResult;
}

const getBooksByAuthorNameIR: any = {"queryName":"GetBooksByAuthorName","statement":"SELECT b.* FROM books b\nINNER JOIN authors a ON a.id = b.author_id\nWHERE a.first_name || ' ' || a.last_name = :authorName!","params":[{"name":"authorName","transform":{"type":"scalar"},"required":true,"locs":[{"a":110,"b":122}]}],"columns":[],"name":"GetBooksByAuthorName_7bd4d355"};

/**
 * Query generated from SQL:
 * ```
 * SELECT b.* FROM books b
 * INNER JOIN authors a ON a.id = b.author_id
 * WHERE a.first_name || ' ' || a.last_name = :authorName!
 * ```
 */
export const getBooksByAuthorName = new TypedQuery<GetBooksByAuthorNameParams,GetBooksByAuthorNameResult>(getBooksByAuthorNameIR);


/** 'AggregateEmailsAndTest' parameters type */
export interface AggregateEmailsAndTestParams {
  testAges?: numberArray | null | void;
}

/** 'AggregateEmailsAndTest' return type */
export interface AggregateEmailsAndTestResult {
  agetest: boolean | null;
  emails: nullableStringArray;
}

/** 'AggregateEmailsAndTest' query type */
export interface AggregateEmailsAndTestQuery {
  params: AggregateEmailsAndTestParams;
  result: AggregateEmailsAndTestResult;
}

const aggregateEmailsAndTestIR: any = {"queryName":"AggregateEmailsAndTest","statement":"SELECT array_agg(email) as emails, array_agg(age) = :testAges as ageTest FROM users","params":[{"name":"testAges","transform":{"type":"scalar"},"required":false,"locs":[{"a":52,"b":61}]}],"columns":[{"name":"emails","nullable":false}],"name":"AggregateEmailsAndTest_93e89f71"};

/**
 * Query generated from SQL:
 * ```
 * SELECT array_agg(email) as emails, array_agg(age) = :testAges as ageTest FROM users
 * ```
 */
export const aggregateEmailsAndTest = new TypedQuery<AggregateEmailsAndTestParams,AggregateEmailsAndTestResult>(aggregateEmailsAndTestIR);


/** 'GetBooks' parameters type */
export type GetBooksParams = void;

/** 'GetBooks' return type */
export interface GetBooksResult {
  id: number;
  name: string;
}

/** 'GetBooks' query type */
export interface GetBooksQuery {
  params: GetBooksParams;
  result: GetBooksResult;
}

const getBooksIR: any = {"queryName":"GetBooks","statement":"SELECT id, name FROM books","params":[],"columns":[{"name":"name","nullable":false}],"name":"GetBooks_0662882f"};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, name FROM books
 * ```
 */
export const getBooks = new TypedQuery<GetBooksParams,GetBooksResult>(getBooksIR);


/** 'CountBooks' parameters type */
export type CountBooksParams = void;

/** 'CountBooks' return type */
export interface CountBooksResult {
  book_count: BigInt | null;
}

/** 'CountBooks' query type */
export interface CountBooksQuery {
  params: CountBooksParams;
  result: CountBooksResult;
}

const countBooksIR: any = {"queryName":"CountBooks","statement":"SELECT count(*) as book_count FROM books","params":[],"columns":[],"name":"CountBooks_81f4d5cc"};

/**
 * Query generated from SQL:
 * ```
 * SELECT count(*) as book_count FROM books
 * ```
 */
export const countBooks = new TypedQuery<CountBooksParams,CountBooksResult>(countBooksIR);


/** 'GetBookCountries' parameters type */
export type GetBookCountriesParams = void;

/** 'GetBookCountries' return type */
export interface GetBookCountriesResult {
  country: Iso31661Alpha2;
  id: number;
}

/** 'GetBookCountries' query type */
export interface GetBookCountriesQuery {
  params: GetBookCountriesParams;
  result: GetBookCountriesResult;
}

const getBookCountriesIR: any = {"queryName":"GetBookCountries","statement":"SELECT * FROM book_country","params":[],"columns":[],"name":"GetBookCountries_64b9080a"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM book_country
 * ```
 */
export const getBookCountries = new TypedQuery<GetBookCountriesParams,GetBookCountriesResult>(getBookCountriesIR);


/** 'CountBooksTotal' parameters type */
export type CountBooksTotalParams = void;

/** 'CountBooksTotal' return type */
export interface CountBooksTotalResult {
  total: number;
}

/** 'CountBooksTotal' query type */
export interface CountBooksTotalQuery {
  params: CountBooksTotalParams;
  result: CountBooksTotalResult;
}

const countBooksTotalIR: any = {"queryName":"CountBooksTotal","statement":"SELECT count(*)::int AS total FROM books","params":[],"columns":[{"name":"total","nullable":false}],"name":"CountBooksTotal_6ed22675"};

/**
 * Query generated from SQL:
 * ```
 * SELECT count(*)::int AS total FROM books
 * ```
 */
export const countBooksTotal = new TypedQuery<CountBooksTotalParams,CountBooksTotalResult>(countBooksTotalIR);


