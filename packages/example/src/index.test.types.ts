/** Types generated for queries found in "src/index.test.ts" */
import type { Category } from './customTypes.js';

export type categoryArray = (Category)[];

/** 'FindBookByIdTag' parameters type */
export interface FindBookByIdTagParams {
  id?: number | null | void;
}

/** 'FindBookByIdTag' return type */
export interface FindBookByIdTagResult {
  author_id: number | null;
  categories: categoryArray | null;
  id: number;
  name: string | null;
  rank: number | null;
}

/** 'FindBookByIdTag' query type */
export interface FindBookByIdTagQuery {
  params: FindBookByIdTagParams;
  result: FindBookByIdTagResult;
}

