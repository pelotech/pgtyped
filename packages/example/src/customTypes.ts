export enum Category {
  Novel = 'novel',
  ScienceFiction = 'science-fiction',
  Thriller = 'thriller',
}

/**
 * The TypeScript type the `email_address` domain is overridden to, in
 * config.json. It is deliberately narrower than `string`: an assignment from
 * one of these to a plain `string` compiles either way, so only a type that
 * `string` does *not* satisfy can prove the override fired rather than the
 * domain flattening to its base type (#503, #594).
 */
export type EmailAddress = `${string}@${string}`;
