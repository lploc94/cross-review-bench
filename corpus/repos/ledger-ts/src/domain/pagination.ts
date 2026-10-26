export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

export interface OffsetPage {
  readonly limit: number;
  readonly offset: number;
}

export interface Page<T> {
  readonly items: T[];
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

/**
 * Build a page from rows fetched with `LIMIT limit + 1`: the extra row only tells whether
 * another page exists and is not returned.
 */
export function toPage<T>(rows: T[], page: OffsetPage): Page<T> {
  const hasMore = rows.length > page.limit;
  return {
    items: hasMore ? rows.slice(0, page.limit) : rows,
    limit: page.limit,
    offset: page.offset,
    hasMore,
  };
}
