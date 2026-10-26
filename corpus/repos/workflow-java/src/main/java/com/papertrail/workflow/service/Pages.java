package com.papertrail.workflow.service;

import com.papertrail.workflow.service.Views.PageView;
import java.util.List;
import java.util.function.Function;
import org.springframework.data.domain.PageRequest;

/**
 * Keyset paging shared by the list queries. A page is fetched with one row more than it returns:
 * that extra row only says whether another page follows.
 */
final class Pages {

  static final int DEFAULT_SIZE = 20;
  static final int MAX_SIZE = 100;

  private Pages() {}

  static int limit(Integer requested) {
    return requested == null ? DEFAULT_SIZE : Math.min(Math.max(requested, 1), MAX_SIZE);
  }

  /** The id the query is asked to pass: rows strictly after it. A first page starts at zero. */
  static long after(Long cursor) {
    return cursor == null ? 0L : cursor;
  }

  static PageRequest first(int limit) {
    return PageRequest.of(0, limit + 1);
  }

  static <E, T> PageView<T> of(List<E> rows, int limit, Function<E, Long> id, Function<E, T> map) {
    boolean more = rows.size() > limit;
    List<E> kept = more ? rows.subList(0, limit) : rows;
    Long next = more ? id.apply(kept.get(kept.size() - 1)) : null;
    return new PageView<>(kept.stream().map(map).toList(), next);
  }
}
