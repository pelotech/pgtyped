/* @name FindBookById */
SELECT * FROM books WHERE id = :id;

/* @name FindBookByCategory */
SELECT * FROM books WHERE :category = ANY(categories);

/* @name FindBookNameOrRank */
SELECT id, name
FROM books
WHERE (name = :name OR rank = :rank);

/* @name FindBookUnicode */
SELECT * FROM books WHERE name = 'שקל';

/*
  @name InsertBooks
  @param books -> ((rank!, name!, authorId!, categories)...)
*/
INSERT INTO books (rank, name, author_id, categories)
VALUES :books RETURNING id as book_id;

/*
  @name UpdateBooksCustom
*/
UPDATE books
SET
    rank = (
        CASE WHEN (:rank::int IS NOT NULL)
                 THEN :rank
             ELSE rank
            END
        )
WHERE id = :id!;

/*
  @name UpdateBooks
*/
UPDATE books
/* ignored comment */
SET
    name = :name,
    rank = :rank
WHERE id = :id!;

/*
  @name UpdateBooksRankNotNull
*/
UPDATE books
SET
    rank = :rank!,
    name = :name
WHERE id = :id!;

/* @name GetBooksByAuthorName */
SELECT b.* FROM books b
INNER JOIN authors a ON a.id = b.author_id
WHERE a.first_name || ' ' || a.last_name = :authorName!;

/*
  @name AggregateEmailsAndTest
  @column emails!
*/
SELECT array_agg(email) as emails, array_agg(age) = :testAges as ageTest FROM users;

/*
  @name GetBooks
  @column name!
*/
SELECT id, name FROM books;

/* @name CountBooks */
SELECT count(*) as book_count FROM books;

/* @name GetBookCountries */
SELECT * FROM book_country;

/*
  @name CountBooksTotal
  @column total!
*/
SELECT count(*)::int AS total FROM books;

/*
  @name UpdateBooksFromValues
  @param books -> ((id!::int4, rank!::int4, name!::text)...)

  Upstream #498, #517 and #630. A `VALUES` list inside a sub-select resolves its
  column types from its own rows and nothing downstream, so with no casts every
  column of `item` comes back `text`: `id` is typed `string`, and the join
  predicate fails at run time with `42883 operator does not exist: integer =
  text`. The casts pin the columns before anything downstream is typechecked.
*/
UPDATE books b
SET rank = item.rank, name = item.name
FROM (VALUES :books) AS item(id, rank, name)
WHERE b.id = item.id
RETURNING b.id, b.rank, b.name;
