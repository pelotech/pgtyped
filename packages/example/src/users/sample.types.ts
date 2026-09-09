/** Types generated for queries found in "src/users/sample.ts" */

/** 'GetUsersWithComments' parameters type */
export interface GetUsersWithCommentsParams {
  minCommentCount: number;
}

/** 'GetUsersWithComments' return type */
export interface GetUsersWithCommentsResult {
  /** Age (in years) */
  age: number | null;
  email: string;
  first_name: string | null;
  id: number;
  last_name: string | null;
  registration_date: string;
  user_name: string;
}

/** 'GetUsersWithComments' query type */
export interface GetUsersWithCommentsQuery {
  params: GetUsersWithCommentsParams;
  result: GetUsersWithCommentsResult;
}

/** 'SelectExistsQuery' parameters type */
export type SelectExistsQueryParams = void;

/** 'SelectExistsQuery' return type */
export interface SelectExistsQueryResult {
  isTransactionExists: boolean | null;
}

/** 'SelectExistsQuery' query type */
export interface SelectExistsQueryQuery {
  params: SelectExistsQueryParams;
  result: SelectExistsQueryResult;
}

