package com.innkeep.booking.persistence;

import com.innkeep.booking.domain.SeasonalRate;
import java.time.LocalDate;
import java.util.Collection;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface SeasonalRateRepository extends JpaRepository<SeasonalRate, Long> {

  List<SeasonalRate> findByRoomTypeIdOrderByPriorityAscIdAsc(long roomTypeId);

  /** Rates of the given room types that cover at least one night of the range, used by pricing. */
  @Query(
      """
      select s from SeasonalRate s
      where s.roomType.id in :roomTypeIds
        and s.startDate <= :lastNight
        and s.endDate >= :firstNight
      order by s.priority, s.id""")
  List<SeasonalRate> findOverlapping(
      @Param("roomTypeIds") Collection<Long> roomTypeIds,
      @Param("firstNight") LocalDate firstNight,
      @Param("lastNight") LocalDate lastNight);
}
