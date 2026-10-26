package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.RoomType;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface RoomTypeRepository extends JpaRepository<RoomType, Long> {

  @EntityGraph(attributePaths = "property")
  Optional<RoomType> findByPropertyCodeAndCode(String propertyCode, String code);

  @EntityGraph(attributePaths = "property")
  List<RoomType> findByPropertyCodeOrderByCodeAsc(String propertyCode);

  /**
   * Locks the room type row {@code FOR NO KEY UPDATE} until the transaction ends, so writers of its
   * rates apply one after the other. Rows that reference the room type (holds, reservations,
   * inventory) take a key share lock, which this does not block.
   */
  @Query(value = "select id from room_type where id = :id for no key update", nativeQuery = true)
  Long lockForUpdate(@Param("id") long id);
}
