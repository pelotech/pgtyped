import { sql } from '@pelotech/pgtyped-runtime';
import { GetUsersWithCommentsQuery } from './sample.types.js';
import { Client } from 'pg';

export async function getUsersWithComment(
  minCommentCount: number,
  client: Client,
) {
  const getUsersWithComments = sql<GetUsersWithCommentsQuery>`
    SELECT u.* FROM users u
    INNER JOIN book_comments bc ON u.id = bc.user_id
    GROUP BY u.id
    HAVING count(bc.id) > $minCommentCount!::int`;
  const result = await getUsersWithComments.run(client, { minCommentCount });
  return result[0];
}

export const selectExistsQuery = sql`SELECT EXISTS ( SELECT 1 WHERE true ) AS "isTransactionExists";`;
