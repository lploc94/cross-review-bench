package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.LedgerEntry;
import java.time.Instant;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface LedgerEntryRepository extends JpaRepository<LedgerEntry, Long> {

  List<LedgerEntry> findByReservationIdOrderByIdAsc(long reservationId);

  /** Sums of ledger amounts per kind for the property's reservations, created in [from, to). */
  @Query(
      """
      select e.kind as kind, sum(e.amount) as total
        from LedgerEntry e, Reservation r
       where e.reservationId = r.id and r.property.code = :code
         and e.createdAt >= :from and e.createdAt < :to
       group by e.kind""")
  List<KindTotal> totalsByKind(
      @Param("code") String code, @Param("from") Instant from, @Param("to") Instant to);
}
