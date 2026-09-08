/** Types generated for queries found in "src/books/books.sql" */
import { PreparedQuery } from '@pelotech/pgtyped-runtime';

import type { Category } from '../customTypes.js';

export type Iso31661Alpha2 = 'AD' | 'AE' | 'AF' | 'AG' | 'AI' | 'AL' | 'AM' | 'AO' | 'AQ' | 'AR' | 'AS' | 'AT' | 'AU' | 'AW' | 'AX' | 'AZ' | 'BA' | 'BB' | 'BD' | 'BE' | 'BF' | 'BG' | 'BH' | 'BI' | 'BJ' | 'BL' | 'BM' | 'BN' | 'BO' | 'BQ' | 'BR' | 'BS' | 'BT' | 'BV' | 'BW' | 'BY' | 'BZ' | 'CA' | 'CC' | 'CD' | 'CF' | 'CG' | 'CH' | 'CI' | 'CK' | 'CL' | 'CM' | 'CN' | 'CO' | 'CR' | 'CU' | 'CV' | 'CW' | 'CX' | 'CY' | 'CZ' | 'DE' | 'DJ' | 'DK' | 'DM' | 'DO' | 'DZ' | 'EC' | 'EE' | 'EG' | 'EH' | 'ER' | 'ES' | 'ET' | 'FI' | 'FJ' | 'FK' | 'FM' | 'FO' | 'FR' | 'GA' | 'GB' | 'GD' | 'GE' | 'GF' | 'GG' | 'GH' | 'GI' | 'GL' | 'GM' | 'GN' | 'GP' | 'GQ' | 'GR' | 'GS' | 'GT' | 'GU' | 'GW' | 'GY' | 'HK' | 'HM' | 'HN' | 'HR' | 'HT' | 'HU' | 'ID' | 'IE' | 'IL' | 'IM' | 'IN' | 'IO' | 'IQ' | 'IR' | 'IS' | 'IT' | 'JE' | 'JM' | 'JO' | 'JP' | 'KE' | 'KG' | 'KH' | 'KI' | 'KM' | 'KN' | 'KP' | 'KR' | 'KW' | 'KY' | 'KZ' | 'LA' | 'LB' | 'LC' | 'LI' | 'LK' | 'LR' | 'LS' | 'LT' | 'LU' | 'LV' | 'LY' | 'MA' | 'MC' | 'MD' | 'ME' | 'MF' | 'MG' | 'MH' | 'MK' | 'ML' | 'MM' | 'MN' | 'MO' | 'MP' | 'MQ' | 'MR' | 'MS' | 'MT' | 'MU' | 'MV' | 'MW' | 'MX' | 'MY' | 'MZ' | 'NA' | 'NC' | 'NE' | 'NF' | 'NG' | 'NI' | 'NL' | 'NO' | 'NP' | 'NR' | 'NU' | 'NZ' | 'OM' | 'PA' | 'PE' | 'PF' | 'PG' | 'PH' | 'PK' | 'PL' | 'PM' | 'PN' | 'PR' | 'PS' | 'PT' | 'PW' | 'PY' | 'QA' | 'RE' | 'RO' | 'RS' | 'RU' | 'RW' | 'SA' | 'SB' | 'SC' | 'SD' | 'SE' | 'SG' | 'SH' | 'SI' | 'SJ' | 'SK' | 'SL' | 'SM' | 'SN' | 'SO' | 'SR' | 'SS' | 'ST' | 'SV' | 'SX' | 'SY' | 'SZ' | 'TC' | 'TD' | 'TF' | 'TG' | 'TH' | 'TJ' | 'TK' | 'TL' | 'TM';

export type category = 'novel' | 'science-fiction' | 'thriller';

export type categoryArray = (Category)[];

export type numberArray = (number)[];

export type stringArray = (string)[];

/** 'FindBookById' parameters type */
export interface IFindBookByIdParams {
  id?: number | null | void;
}

/** 'FindBookById' return type */
export interface IFindBookByIdResult {
  author_id: number | null;
  categories: categoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookById' query type */
export interface IFindBookByIdQuery {
  params: IFindBookByIdParams;
  result: IFindBookByIdResult;
}

const findBookByIdIR: any = {"queryName":"FindBookById","statement":"SELECT * FROM books WHERE id = :id","params":[{"name":"id","transform":{"type":"scalar"},"required":false,"locs":[{"a":31,"b":34}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM books WHERE id = :id
 * ```
 */
export const findBookById = new PreparedQuery<IFindBookByIdParams,IFindBookByIdResult>(findBookByIdIR);


/** 'FindBookByCategory' parameters type */
export interface IFindBookByCategoryParams {
  category?: category | null | void;
}

/** 'FindBookByCategory' return type */
export interface IFindBookByCategoryResult {
  author_id: number | null;
  categories: categoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookByCategory' query type */
export interface IFindBookByCategoryQuery {
  params: IFindBookByCategoryParams;
  result: IFindBookByCategoryResult;
}

const findBookByCategoryIR: any = {"queryName":"FindBookByCategory","statement":"SELECT * FROM books WHERE :category = ANY(categories)","params":[{"name":"category","transform":{"type":"scalar"},"required":false,"locs":[{"a":26,"b":35}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM books WHERE :category = ANY(categories)
 * ```
 */
export const findBookByCategory = new PreparedQuery<IFindBookByCategoryParams,IFindBookByCategoryResult>(findBookByCategoryIR);


/** 'FindBookNameOrRank' parameters type */
export interface IFindBookNameOrRankParams {
  name?: string | null | void;
  rank?: number | null | void;
}

/** 'FindBookNameOrRank' return type */
export interface IFindBookNameOrRankResult {
  id: number;
  name: string | null;
}

/** 'FindBookNameOrRank' query type */
export interface IFindBookNameOrRankQuery {
  params: IFindBookNameOrRankParams;
  result: IFindBookNameOrRankResult;
}

const findBookNameOrRankIR: any = {"queryName":"FindBookNameOrRank","statement":"SELECT id, name\nFROM books\nWHERE (name = :name OR rank = :rank)","params":[{"name":"name","transform":{"type":"scalar"},"required":false,"locs":[{"a":41,"b":46}]},{"name":"rank","transform":{"type":"scalar"},"required":false,"locs":[{"a":57,"b":62}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, name
 * FROM books
 * WHERE (name = :name OR rank = :rank)
 * ```
 */
export const findBookNameOrRank = new PreparedQuery<IFindBookNameOrRankParams,IFindBookNameOrRankResult>(findBookNameOrRankIR);


/** 'FindBookUnicode' parameters type */
export type IFindBookUnicodeParams = void;

/** 'FindBookUnicode' return type */
export interface IFindBookUnicodeResult {
  author_id: number | null;
  categories: categoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookUnicode' query type */
export interface IFindBookUnicodeQuery {
  params: IFindBookUnicodeParams;
  result: IFindBookUnicodeResult;
}

const findBookUnicodeIR: any = {"queryName":"FindBookUnicode","statement":"SELECT * FROM books WHERE name = 'שקל'","params":[],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM books WHERE name = 'שקל'
 * ```
 */
export const findBookUnicode = new PreparedQuery<IFindBookUnicodeParams,IFindBookUnicodeResult>(findBookUnicodeIR);


/** 'InsertBooks' parameters type */
export interface IInsertBooksParams {
  books: readonly ({
    rank: number,
    name: string,
    authorId: number,
    categories: categoryArray | null | void
  })[];
}

/** 'InsertBooks' return type */
export interface IInsertBooksResult {
  book_id: number;
}

/** 'InsertBooks' query type */
export interface IInsertBooksQuery {
  params: IInsertBooksParams;
  result: IInsertBooksResult;
}

const insertBooksIR: any = {"queryName":"InsertBooks","statement":"INSERT INTO books (rank, name, author_id, categories)\nVALUES :books RETURNING id as book_id","params":[{"name":"books","transform":{"type":"pick_array_spread","keys":[{"name":"rank","required":true},{"name":"name","required":true},{"name":"authorId","required":true},{"name":"categories","required":false}]},"required":false,"locs":[{"a":61,"b":67}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO books (rank, name, author_id, categories)
 * VALUES :books RETURNING id as book_id
 * ```
 */
export const insertBooks = new PreparedQuery<IInsertBooksParams,IInsertBooksResult>(insertBooksIR);


/** 'UpdateBooksCustom' parameters type */
export interface IUpdateBooksCustomParams {
  id: number;
  rank?: number | null | void;
}

/** 'UpdateBooksCustom' return type */
export type IUpdateBooksCustomResult = void;

/** 'UpdateBooksCustom' query type */
export interface IUpdateBooksCustomQuery {
  params: IUpdateBooksCustomParams;
  result: IUpdateBooksCustomResult;
}

const updateBooksCustomIR: any = {"queryName":"UpdateBooksCustom","statement":"UPDATE books\nSET\n    rank = (\n        CASE WHEN (:rank::int IS NOT NULL)\n                 THEN :rank\n             ELSE rank\n            END\n        )\nWHERE id = :id!","params":[{"name":"rank","transform":{"type":"scalar"},"required":false,"locs":[{"a":49,"b":54},{"a":95,"b":100}]},{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":161,"b":165}]}],"columns":[]};

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
export const updateBooksCustom = new PreparedQuery<IUpdateBooksCustomParams,IUpdateBooksCustomResult>(updateBooksCustomIR);


/** 'UpdateBooks' parameters type */
export interface IUpdateBooksParams {
  id: number;
  name?: string | null | void;
  rank?: number | null | void;
}

/** 'UpdateBooks' return type */
export type IUpdateBooksResult = void;

/** 'UpdateBooks' query type */
export interface IUpdateBooksQuery {
  params: IUpdateBooksParams;
  result: IUpdateBooksResult;
}

const updateBooksIR: any = {"queryName":"UpdateBooks","statement":"UPDATE books\n                     \nSET\n    name = :name,\n    rank = :rank\nWHERE id = :id!","params":[{"name":"name","transform":{"type":"scalar"},"required":false,"locs":[{"a":50,"b":55}]},{"name":"rank","transform":{"type":"scalar"},"required":false,"locs":[{"a":68,"b":73}]},{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":85,"b":89}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * UPDATE books
 *                      
 * SET
 *     name = :name,
 *     rank = :rank
 * WHERE id = :id!
 * ```
 */
export const updateBooks = new PreparedQuery<IUpdateBooksParams,IUpdateBooksResult>(updateBooksIR);


/** 'UpdateBooksRankNotNull' parameters type */
export interface IUpdateBooksRankNotNullParams {
  id: number;
  name?: string | null | void;
  rank: number;
}

/** 'UpdateBooksRankNotNull' return type */
export type IUpdateBooksRankNotNullResult = void;

/** 'UpdateBooksRankNotNull' query type */
export interface IUpdateBooksRankNotNullQuery {
  params: IUpdateBooksRankNotNullParams;
  result: IUpdateBooksRankNotNullResult;
}

const updateBooksRankNotNullIR: any = {"queryName":"UpdateBooksRankNotNull","statement":"UPDATE books\nSET\n    rank = :rank!,\n    name = :name\nWHERE id = :id!","params":[{"name":"rank","transform":{"type":"scalar"},"required":true,"locs":[{"a":28,"b":34}]},{"name":"name","transform":{"type":"scalar"},"required":false,"locs":[{"a":47,"b":52}]},{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":64,"b":68}]}],"columns":[]};

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
export const updateBooksRankNotNull = new PreparedQuery<IUpdateBooksRankNotNullParams,IUpdateBooksRankNotNullResult>(updateBooksRankNotNullIR);


/** 'GetBooksByAuthorName' parameters type */
export interface IGetBooksByAuthorNameParams {
  authorName: string;
}

/** 'GetBooksByAuthorName' return type */
export interface IGetBooksByAuthorNameResult {
  author_id: number | null;
  categories: categoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'GetBooksByAuthorName' query type */
export interface IGetBooksByAuthorNameQuery {
  params: IGetBooksByAuthorNameParams;
  result: IGetBooksByAuthorNameResult;
}

const getBooksByAuthorNameIR: any = {"queryName":"GetBooksByAuthorName","statement":"SELECT b.* FROM books b\nINNER JOIN authors a ON a.id = b.author_id\nWHERE a.first_name || ' ' || a.last_name = :authorName!","params":[{"name":"authorName","transform":{"type":"scalar"},"required":true,"locs":[{"a":110,"b":122}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT b.* FROM books b
 * INNER JOIN authors a ON a.id = b.author_id
 * WHERE a.first_name || ' ' || a.last_name = :authorName!
 * ```
 */
export const getBooksByAuthorName = new PreparedQuery<IGetBooksByAuthorNameParams,IGetBooksByAuthorNameResult>(getBooksByAuthorNameIR);


/** 'AggregateEmailsAndTest' parameters type */
export interface IAggregateEmailsAndTestParams {
  testAges?: numberArray | null | void;
}

/** 'AggregateEmailsAndTest' return type */
export interface IAggregateEmailsAndTestResult {
  agetest: boolean | null;
  emails: stringArray;
}

/** 'AggregateEmailsAndTest' query type */
export interface IAggregateEmailsAndTestQuery {
  params: IAggregateEmailsAndTestParams;
  result: IAggregateEmailsAndTestResult;
}

const aggregateEmailsAndTestIR: any = {"queryName":"AggregateEmailsAndTest","statement":"SELECT array_agg(email) as \"emails!\", array_agg(age) = :testAges as ageTest FROM users","params":[{"name":"testAges","transform":{"type":"scalar"},"required":false,"locs":[{"a":55,"b":64}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT array_agg(email) as "emails!", array_agg(age) = :testAges as ageTest FROM users
 * ```
 */
export const aggregateEmailsAndTest = new PreparedQuery<IAggregateEmailsAndTestParams,IAggregateEmailsAndTestResult>(aggregateEmailsAndTestIR);


/** 'GetBooks' parameters type */
export type IGetBooksParams = void;

/** 'GetBooks' return type */
export interface IGetBooksResult {
  id: number;
  name: string;
}

/** 'GetBooks' query type */
export interface IGetBooksQuery {
  params: IGetBooksParams;
  result: IGetBooksResult;
}

const getBooksIR: any = {"queryName":"GetBooks","statement":"SELECT id, name as \"name!\" FROM books","params":[],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT id, name as "name!" FROM books
 * ```
 */
export const getBooks = new PreparedQuery<IGetBooksParams,IGetBooksResult>(getBooksIR);


/** 'CountBooks' parameters type */
export type ICountBooksParams = void;

/** 'CountBooks' return type */
export interface ICountBooksResult {
  book_count: BigInt | null;
}

/** 'CountBooks' query type */
export interface ICountBooksQuery {
  params: ICountBooksParams;
  result: ICountBooksResult;
}

const countBooksIR: any = {"queryName":"CountBooks","statement":"SELECT count(*) as book_count FROM books","params":[],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT count(*) as book_count FROM books
 * ```
 */
export const countBooks = new PreparedQuery<ICountBooksParams,ICountBooksResult>(countBooksIR);


/** 'GetBookCountries' parameters type */
export type IGetBookCountriesParams = void;

/** 'GetBookCountries' return type */
export interface IGetBookCountriesResult {
  country: Iso31661Alpha2;
  id: number;
}

/** 'GetBookCountries' query type */
export interface IGetBookCountriesQuery {
  params: IGetBookCountriesParams;
  result: IGetBookCountriesResult;
}

const getBookCountriesIR: any = {"queryName":"GetBookCountries","statement":"SELECT * FROM book_country","params":[],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM book_country
 * ```
 */
export const getBookCountries = new PreparedQuery<IGetBookCountriesParams,IGetBookCountriesResult>(getBookCountriesIR);


