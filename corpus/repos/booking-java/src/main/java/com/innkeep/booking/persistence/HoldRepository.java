package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.Hold;
import com.innkeep.booking.domain.HoldStatus;
import jakarta.persistence.LockModeType;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface HoldRepository extends JpaRepository<Hold, UUID> {

  @Override
  @EntityGraph(attributePaths = {"property", "roomType", "priceLines"})
  Optional<Hold> findById(UUID id);

  /**
   * Loads the hold under a row lock on the hold row alone. A join fetch here would make Postgres
   * lock the property and room type rows too, which blocks other guests for the whole charge.
   */
  @Lock(LockModeType.PESSIMISTIC_WRITE)
  @Query("select h from Hold h where h.id = :id")
  Optional<Hold> findLockedById(@Param("id") UUID id);

  @Query(
      value =
          """
          select h from Hold h
            join fetch h.property
            join fetch h.roomType
           where h.status = :status and (:code is null or h.property.code = :code)
           order by h.expiresAt, h.id""",
      countQuery =
          """
          select count(h) from Hold h
           where h.status = :status and (:code is null or h.property.code = :code)""")
  Page<Hold> findForAdmin(
      @Param("status") HoldStatus status, @Param("code") String code, Pageable pageable);

  /**
   * The next holds that are due, after a cursor of (expiry, id), in that order. The cursor moves
   * past holds the sweep skips, so a page of busy holds never hides the due ones behind it.
   */
  @Query(
      """
      select h from Hold h
       where h.status = :status and h.expiresAt <= :now
         and (h.expiresAt > :afterExpiry or (h.expiresAt = :afterExpiry and h.id > :afterId))
       order by h.expiresAt, h.id""")
  List<Hold> findDueAfter(
      @Param("status") HoldStatus status,
      @Param("now") Instant now,
      @Param("afterExpiry") Instant afterExpiry,
      @Param("afterId") UUID afterId,
      Pageable page);

  @Query("select h.status as status, count(h) as total from Hold h group by h.status")
  List<HoldStatusCount> countByStatus();
}
