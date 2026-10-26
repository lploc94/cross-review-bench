package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.Reservation;
import com.innkeep.booking.domain.ReservationStatus;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface ReservationRepository extends JpaRepository<Reservation, Long> {

  @EntityGraph(attributePaths = {"property", "roomType", "priceLines"})
  Optional<Reservation> findByReference(String reference);

  /**
   * One page of reservations with property and room type fetched in the same statement, so listing
   * N reservations costs the same number of statements as listing one. Ordered by check-in and id,
   * which keeps pages stable.
   */
  @Query(
      value =
          """
          select r from Reservation r
            join fetch r.property
            join fetch r.roomType
           where (:code is null or r.property.code = :code)
             and (:status is null or r.status = :status)
             and (:from is null or r.checkIn >= :from)
             and (:to is null or r.checkOut <= :to)
             and (:email is null or r.guest.email = :email)
             and (:guest is null or lower(r.guest.name) like :guest)
           order by r.checkIn, r.id""",
      countQuery =
          """
          select count(r) from Reservation r
           where (:code is null or r.property.code = :code)
             and (:status is null or r.status = :status)
             and (:from is null or r.checkIn >= :from)
             and (:to is null or r.checkOut <= :to)
             and (:email is null or r.guest.email = :email)
             and (:guest is null or lower(r.guest.name) like :guest)""")
  Page<Reservation> search(
      @Param("code") String code,
      @Param("status") ReservationStatus status,
      @Param("from") LocalDate from,
      @Param("to") LocalDate to,
      @Param("email") String email,
      @Param("guest") String guestNamePattern,
      Pageable pageable);

  /** The next stays with the given status after a cursor id, in id order. */
  @Query(
      """
      select r from Reservation r
        join fetch r.property
       where r.status = :status and r.id > :afterId
       order by r.id""")
  List<Reservation> findBatchAfter(
      @Param("status") ReservationStatus status, @Param("afterId") long afterId, Pageable pageable);

  @Query("select r.status as status, count(r) as total from Reservation r group by r.status")
  List<StatusCount> countByStatus();

  @Query(
      """
      select r from Reservation r
        join fetch r.property
        join fetch r.roomType
       where r.property.code = :code and r.checkIn = :day and r.status = com.innkeep.booking.domain.ReservationStatus.CONFIRMED
       order by r.id""")
  List<Reservation> findArrivals(@Param("code") String code, @Param("day") LocalDate day);

  @Query(
      """
      select r from Reservation r
        join fetch r.property
        join fetch r.roomType
       where r.property.code = :code and r.checkOut = :day and r.status = com.innkeep.booking.domain.ReservationStatus.CHECKED_IN
       order by r.id""")
  List<Reservation> findDepartures(@Param("code") String code, @Param("day") LocalDate day);

  @Query(
      """
      select r from Reservation r
        join fetch r.property
        join fetch r.roomType
       where r.property.code = :code and r.status = com.innkeep.booking.domain.ReservationStatus.CHECKED_IN
         and r.checkIn <= :day and r.checkOut > :day
       order by r.roomType.code, r.id""")
  List<Reservation> findInHouse(@Param("code") String code, @Param("day") LocalDate day);
}
