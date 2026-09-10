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

