/** Types generated for queries found in "src/comments/comments.sql" */
import { TypedQuery } from '@pelotech/pgtyped-runtime';

/** 'GetAllComments' parameters type */
export interface GetAllCommentsParams {
  id: number;
}

/** 'GetAllComments' return type */
export interface GetAllCommentsResult {
  body: string | null;
  book_id: number | null;
  id: number;
  user_id: number | null;
}

/** 'GetAllComments' query type */
export interface GetAllCommentsQuery {
  params: GetAllCommentsParams;
  result: GetAllCommentsResult;
}

const getAllCommentsIR: any = {"queryName":"GetAllComments","statement":"SELECT * FROM book_comments WHERE id = :id! OR user_id = :id","params":[{"name":"id","transform":{"type":"scalar"},"required":true,"locs":[{"a":39,"b":43},{"a":57,"b":60}]}],"columns":[],"name":"GetAllComments_e22729a0"};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM book_comments WHERE id = :id! OR user_id = :id
 * ```
 */
export const getAllComments = new TypedQuery<GetAllCommentsParams,GetAllCommentsResult>(getAllCommentsIR);


/** 'GetAllCommentsByIds' parameters type */
export interface GetAllCommentsByIdsParams {
  ids: readonly (number)[];
}

/** 'GetAllCommentsByIds' return type */
export interface GetAllCommentsByIdsResult {
  body: string | null;
  book_id: number | null;
  id: number;
  user_id: number | null;
}

/** 'GetAllCommentsByIds' query type */
export interface GetAllCommentsByIdsQuery {
  params: GetAllCommentsByIdsParams;
  result: GetAllCommentsByIdsResult;
}

const getAllCommentsByIdsIR: any = {"queryName":"GetAllCommentsByIds","statement":"SELECT * FROM book_comments WHERE id in :ids AND id in :ids!","params":[{"name":"ids","transform":{"type":"array_spread"},"required":true,"locs":[{"a":40,"b":44},{"a":55,"b":60}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * SELECT * FROM book_comments WHERE id in :ids AND id in :ids!
 * ```
 */
export const getAllCommentsByIds = new TypedQuery<GetAllCommentsByIdsParams,GetAllCommentsByIdsResult>(getAllCommentsByIdsIR);


/** 'InsertComment' parameters type */
export interface InsertCommentParams {
  comments: readonly ({
    userId: number,
    commentBody: string
  })[];
}

/** 'InsertComment' return type */
export interface InsertCommentResult {
  body: string | null;
  book_id: number | null;
  id: number;
  user_id: number | null;
}

/** 'InsertComment' query type */
export interface InsertCommentQuery {
  params: InsertCommentParams;
  result: InsertCommentResult;
}

const insertCommentIR: any = {"queryName":"InsertComment","statement":"INSERT INTO book_comments (user_id, body)\n-- NOTE: this is a note\nVALUES :comments RETURNING *","params":[{"name":"comments","transform":{"type":"pick_array_spread","keys":[{"name":"userId","required":true},{"name":"commentBody","required":true}]},"required":false,"locs":[{"a":73,"b":82}]}],"columns":[]};

/**
 * Query generated from SQL:
 * ```
 * INSERT INTO book_comments (user_id, body)
 * -- NOTE: this is a note
 * VALUES :comments RETURNING *
 * ```
 */
export const insertComment = new TypedQuery<InsertCommentParams,InsertCommentResult>(insertCommentIR);


/** 'SelectExistsTest' parameters type */
export type SelectExistsTestParams = void;

/** 'SelectExistsTest' return type */
export interface SelectExistsTestResult {
  isTransactionExists: boolean | null;
}

/** 'SelectExistsTest' query type */
export interface SelectExistsTestQuery {
  params: SelectExistsTestParams;
  result: SelectExistsTestResult;
}

const selectExistsTestIR: any = {"queryName":"SelectExistsTest","statement":"SELECT EXISTS ( SELECT 1 WHERE true ) AS \"isTransactionExists\"","params":[],"columns":[],"name":"SelectExistsTest_2d2dbdd7"};

/**
 * Query generated from SQL:
 * ```
 * SELECT EXISTS ( SELECT 1 WHERE true ) AS "isTransactionExists"
 * ```
 */
export const selectExistsTest = new TypedQuery<SelectExistsTestParams,SelectExistsTestResult>(selectExistsTestIR);


