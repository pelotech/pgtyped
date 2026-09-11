/** Types generated for queries found in "src/index.test.ts" */
import type { nullableCategoryArray } from './pgtyped-shared.js';

/** 'FindBookByIdTag' parameters type */
export interface FindBookByIdTagParams {
  id?: number | null | void;
}

/** 'FindBookByIdTag' return type */
export interface FindBookByIdTagResult {
  author_id: number | null;
  categories: nullableCategoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookByIdTag' query type */
export interface FindBookByIdTagQuery {
  params: FindBookByIdTagParams;
  result: FindBookByIdTagResult;
}

/** 'FindBooksRankedAboveTag' parameters type */
export interface FindBooksRankedAboveTagParams {
  minRank: number;
}

/** 'FindBooksRankedAboveTag' return type */
export interface FindBooksRankedAboveTagResult {
  id: number;
  rank: number | null;
}

/** 'FindBooksRankedAboveTag' query type */
export interface FindBooksRankedAboveTagQuery {
  params: FindBooksRankedAboveTagParams;
  result: FindBooksRankedAboveTagResult;
}

/** 'UpdateBooksFromValuesTag' parameters type */
export interface UpdateBooksFromValuesTagParams {
  books: readonly ({
    id: number,
    rank: number,
    name: string
  })[];
}

/** 'UpdateBooksFromValuesTag' return type */
export interface UpdateBooksFromValuesTagResult {
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'UpdateBooksFromValuesTag' query type */
export interface UpdateBooksFromValuesTagQuery {
  params: UpdateBooksFromValuesTagParams;
  result: UpdateBooksFromValuesTagResult;
}

/** 'CountBookCommentsTag' parameters type */
export type CountBookCommentsTagParams = void;

/** 'CountBookCommentsTag' return type */
export interface CountBookCommentsTagResult {
  total: number | null;
}

/** 'CountBookCommentsTag' query type */
export interface CountBookCommentsTagQuery {
  params: CountBookCommentsTagParams;
  result: CountBookCommentsTagResult;
}

