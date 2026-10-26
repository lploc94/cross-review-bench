package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.Inventory;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

/**
 * Inventory counters change only through these conditional updates. Each one returns the number of
 * rows it changed: 0 means the night had too few free rooms (or no row), so the caller rolls the
 * whole unit of work back. The versions are bumped by hand because bulk updates skip them.
 */
public interface InventoryRepository extends JpaRepository<Inventory, Long> {

  @Modifying(flushAutomatically = true)
  @Query(
      """
      update Inventory i
         set i.held = i.held + :rooms, i.version = i.version + 1
       where i.roomType.id = :roomTypeId and i.night = :night
         and i.total - i.held - i.booked >= :rooms""")
  int holdRooms(
      @Param("roomTypeId") long roomTypeId,
      @Param("night") LocalDate night,
      @Param("rooms") int rooms);

  @Modifying(flushAutomatically = true)
  @Query(
      """
      update Inventory i
         set i.held = i.held - :rooms, i.booked = i.booked + :rooms, i.version = i.version + 1
       where i.roomType.id = :roomTypeId and i.night = :night and i.held >= :rooms""")
  int confirmHeld(
      @Param("roomTypeId") long roomTypeId,
      @Param("night") LocalDate night,
      @Param("rooms") int rooms);

  @Modifying(flushAutomatically = true)
  @Query(
      """
      update Inventory i
         set i.held = i.held - :rooms, i.version = i.version + 1
       where i.roomType.id = :roomTypeId and i.night = :night and i.held >= :rooms""")
  int releaseHeld(
      @Param("roomTypeId") long roomTypeId,
      @Param("night") LocalDate night,
      @Param("rooms") int rooms);

  @Modifying(flushAutomatically = true)
  @Query(
      """
      update Inventory i
         set i.booked = i.booked - :rooms, i.version = i.version + 1
       where i.roomType.id = :roomTypeId and i.night = :night and i.booked >= :rooms""")
  int releaseBooked(
      @Param("roomTypeId") long roomTypeId,
      @Param("night") LocalDate night,
      @Param("rooms") int rooms);

  Optional<Inventory> findByRoomTypeIdAndNight(long roomTypeId, LocalDate night);

  List<Inventory> findByRoomTypeIdAndNightBetweenOrderByNightAsc(
      long roomTypeId, LocalDate firstNight, LocalDate lastNight);

  @Query(
      """
      select new com.innkeep.booking.persistence.RoomAvailability(
          i.roomType.id, min(i.total - i.held - i.booked), count(i))
        from Inventory i
       where i.roomType.property.code = :propertyCode
         and i.night between :firstNight and :lastNight
       group by i.roomType.id""")
  List<RoomAvailability> summarize(
      @Param("propertyCode") String propertyCode,
      @Param("firstNight") LocalDate firstNight,
      @Param("lastNight") LocalDate lastNight);

  /**
   * Inventory of every room type of the property for the nights from {@code first} to {@code last}.
   */
  @Query(
      """
      select i from Inventory i
        join fetch i.roomType t
        join t.property p
       where p.code = :code and i.night between :first and :last
       order by i.night, t.code""")
  List<Inventory> findForProperty(
      @Param("code") String code, @Param("first") LocalDate first, @Param("last") LocalDate last);
}
