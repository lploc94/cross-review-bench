package com.innkeep.booking.service;

import com.innkeep.booking.domain.ConflictException;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.Inventory;
import com.innkeep.booking.domain.NotFoundException;
import com.innkeep.booking.domain.Property;
import com.innkeep.booking.domain.RoomType;
import com.innkeep.booking.domain.SeasonalRate;
import com.innkeep.booking.domain.ValidationException;
import com.innkeep.booking.persistence.InventoryRepository;
import com.innkeep.booking.persistence.PropertyRepository;
import com.innkeep.booking.persistence.RoomTypeRepository;
import com.innkeep.booking.persistence.SeasonalRateRepository;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.Comparator;
import java.util.Currency;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.regex.Pattern;
import org.springframework.data.domain.Sort;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * Properties, room types, seasonal rates and inventory: read access for guests and the admin writes
 * behind them. Every write is validated here, so the database constraints are a backstop rather
 * than the first line of defence.
 */
@Service
public class CatalogService {

  private static final Pattern CODE = Pattern.compile("[a-z0-9]+(-[a-z0-9]+)*");
  private static final int MAX_INVENTORY_NIGHTS = 366;

  private final PropertyRepository properties;
  private final RoomTypeRepository roomTypes;
  private final SeasonalRateRepository seasonalRates;
  private final InventoryRepository inventory;
  private final TransactionTemplate tx;
  private final OptimisticRetry retry;

  public CatalogService(
      PropertyRepository properties,
      RoomTypeRepository roomTypes,
      SeasonalRateRepository seasonalRates,
      InventoryRepository inventory,
      TransactionTemplate tx,
      OptimisticRetry retry) {
    this.properties = properties;
    this.roomTypes = roomTypes;
    this.seasonalRates = seasonalRates;
    this.inventory = inventory;
    this.tx = tx;
    this.retry = retry;
  }

  public List<Property> properties() {
    return properties.findAll(Sort.by("code"));
  }

  public Property property(String code) {
    return properties.findByCode(code).orElseThrow(() -> new NotFoundException("property", code));
  }

  public List<RoomType> roomTypes(String propertyCode) {
    property(propertyCode);
    return roomTypes.findByPropertyCodeOrderByCodeAsc(propertyCode);
  }

  public RoomType roomType(String propertyCode, String roomTypeCode) {
    return roomTypes
        .findByPropertyCodeAndCode(propertyCode, roomTypeCode)
        .orElseThrow(() -> new NotFoundException("room type", propertyCode + "/" + roomTypeCode));
  }

  public Property createProperty(PropertyDraft draft) {
    requireCode(draft.code());
    requireText("name", draft.name());
    validatePolicy(
        new PolicyDraft(
            draft.fullRefundDays(),
            draft.partialRefundPercent(),
            draft.weekendSurchargePercent(),
            draft.losMinNights(),
            draft.losDiscountPercent()));
    if (draft.checkInTime() == null || draft.checkOutTime() == null) {
      throw new ValidationException("check-in and check-out times are required");
    }
    if (properties.findByCode(draft.code()).isPresent()) {
      throw new ConflictException("property " + draft.code() + " already exists");
    }
    return properties.save(
        new Property(
            draft.code(),
            draft.name().trim(),
            zone(draft.timeZone()),
            draft.checkInTime(),
            draft.checkOutTime(),
            currency(draft.currency()),
            draft.fullRefundDays(),
            draft.partialRefundPercent(),
            draft.weekendSurchargePercent(),
            draft.losMinNights(),
            draft.losDiscountPercent()));
  }

  /** Replaces the refund and pricing rules; cancellations and quotes made later use them. */
  public Property changePolicy(String propertyCode, PolicyDraft draft) {
    validatePolicy(draft);
    return tx.execute(
        status -> {
          Property property = property(propertyCode);
          property.changePolicy(
              draft.fullRefundDays(),
              draft.partialRefundPercent(),
              draft.weekendSurchargePercent(),
              draft.losMinNights(),
              draft.losDiscountPercent());
          return property;
        });
  }

  public RoomType createRoomType(String propertyCode, RoomTypeDraft draft) {
    Property property = property(propertyCode);
    requireCode(draft.code());
    requireText("name", draft.name());
    requireBetween("capacity", draft.capacity(), 1, 20);
    requireMoney("base nightly rate", draft.baseNightlyRate(), property.currency());
    requireMoney("extra guest fee", draft.extraGuestFee(), property.currency());
    if (roomTypes.findByPropertyCodeAndCode(propertyCode, draft.code()).isPresent()) {
      throw new ConflictException("room type " + draft.code() + " already exists");
    }
    return roomTypes.save(
        new RoomType(
            property,
            draft.code(),
            draft.name().trim(),
            draft.capacity(),
            draft.baseNightlyRate(),
            draft.extraGuestFee()));
  }

  public RoomType reprice(
      String propertyCode,
      String roomTypeCode,
      BigDecimal baseNightlyRate,
      BigDecimal extraGuestFee) {
    return tx.execute(
        status -> {
          RoomType type = roomType(propertyCode, roomTypeCode);
          Currency currency = type.getProperty().currency();
          requireMoney("base nightly rate", baseNightlyRate, currency);
          requireMoney("extra guest fee", extraGuestFee, currency);
          type.reprice(baseNightlyRate, extraGuestFee);
          return type;
        });
  }

  /**
   * Adds a seasonal rate. Adding and changing rates lock the room type row first, so two writers
   * check for overlaps one after the other and cannot both pass.
   */
  public SeasonalRate addSeasonalRate(
      String propertyCode, String roomTypeCode, SeasonalRateDraft draft) {
    return tx.execute(
        status -> {
          RoomType type = roomType(propertyCode, roomTypeCode);
          roomTypes.lockForUpdate(type.getId());
          requireSeasonalRate(type, draft, null);
          return seasonalRates.save(
              new SeasonalRate(
                  type, draft.startDate(), draft.endDate(), draft.nightlyRate(), draft.priority()));
        });
  }

  /** Replaces the dates, rate and priority of one seasonal rate, under the same overlap rule. */
  public SeasonalRate updateSeasonalRate(
      String propertyCode, String roomTypeCode, long rateId, SeasonalRateDraft draft) {
    return tx.execute(
        status -> {
          RoomType type = roomType(propertyCode, roomTypeCode);
          roomTypes.lockForUpdate(type.getId());
          SeasonalRate rate = ownedRate(type, rateId);
          requireSeasonalRate(type, draft, rateId);
          rate.change(draft.startDate(), draft.endDate(), draft.nightlyRate(), draft.priority());
          return rate;
        });
  }

  public List<SeasonalRate> seasonalRates(String propertyCode, String roomTypeCode) {
    return seasonalRates.findByRoomTypeIdOrderByPriorityAscIdAsc(
        roomType(propertyCode, roomTypeCode).getId());
  }

  /** Removes one seasonal rate; a rate that belongs to another room type is not found. */
  public void removeSeasonalRate(String propertyCode, String roomTypeCode, long rateId) {
    tx.executeWithoutResult(
        status -> {
          RoomType type = roomType(propertyCode, roomTypeCode);
          seasonalRates.delete(ownedRate(type, rateId));
        });
  }

  /**
   * Inventory rows from {@code range.checkIn()} up to {@code range.checkOut()}, ordered by night.
   */
  public List<Inventory> inventory(String propertyCode, String roomTypeCode, DateRange range) {
    if (range.nights() > MAX_INVENTORY_NIGHTS) {
      throw new ValidationException("at most " + MAX_INVENTORY_NIGHTS + " nights at a time");
    }
    RoomType type = roomType(propertyCode, roomTypeCode);
    return inventory.findByRoomTypeIdAndNightBetweenOrderByNightAsc(
        type.getId(), range.checkIn(), range.lastNight());
  }

  /**
   * Sets the sellable total for each listed night, creating the rows that do not exist yet. The
   * whole list applies or none of it does. Returns the number of nights written. Setting totals is
   * idempotent, so a write that loses a version race on an existing night is simply retried. Two
   * requests that create the same new night at once do not both insert it: the later one is refused
   * by the unique key and answered 409, and can be sent again.
   */
  public int setInventory(String propertyCode, String roomTypeCode, List<NightTotal> nights) {
    if (nights.isEmpty()) {
      throw new ValidationException("at least one night is required");
    }
    var seen = new HashSet<LocalDate>();
    for (NightTotal row : nights) {
      if (!seen.add(row.night())) {
        throw new ValidationException("night " + row.night() + " is listed twice");
      }
    }
    List<NightTotal> byNight =
        nights.stream().sorted(Comparator.comparing(NightTotal::night)).toList();
    return retry.run(
        () ->
            tx.execute(
                status -> {
                  RoomType type = roomType(propertyCode, roomTypeCode);
                  // Ascending night order, as holds take their nights: two writers that lock the
                  // same rows in opposite orders deadlock.
                  for (NightTotal row : byNight) {
                    Inventory existing =
                        inventory.findByRoomTypeIdAndNight(type.getId(), row.night()).orElse(null);
                    if (existing == null) {
                      inventory.save(new Inventory(type, row.night(), row.total()));
                    } else {
                      existing.setTotal(row.total());
                    }
                  }
                  return nights.size();
                }));
  }

  private SeasonalRate ownedRate(RoomType type, long rateId) {
    return seasonalRates
        .findById(rateId)
        .filter(rate -> rate.getRoomType().getId().equals(type.getId()))
        .orElseThrow(() -> new NotFoundException("seasonal rate", String.valueOf(rateId)));
  }

  /**
   * A seasonal rate must have an end on or after its start, a sensible priority and a rate in the
   * property's currency. Two rates of the same priority may not share a night, because the lowest
   * priority number wins and a tie would be decided by id, which nobody chose.
   */
  private void requireSeasonalRate(RoomType type, SeasonalRateDraft draft, Long ignoredRateId) {
    if (draft.startDate() == null || draft.endDate() == null) {
      throw new ValidationException("start and end dates are required");
    }
    if (draft.endDate().isBefore(draft.startDate())) {
      throw new ValidationException("the seasonal rate ends before it starts");
    }
    requireMoney("nightly rate", draft.nightlyRate(), type.getProperty().currency());
    requireBetween("priority", draft.priority(), 0, 100);
    boolean clash =
        seasonalRates
            .findOverlapping(List.of(type.getId()), draft.startDate(), draft.endDate())
            .stream()
            .anyMatch(
                other ->
                    !Objects.equals(other.getId(), ignoredRateId)
                        && other.getPriority() == draft.priority());
    if (clash) {
      throw new ConflictException(
          "another seasonal rate with priority "
              + draft.priority()
              + " covers some of those dates");
    }
  }

  private static void validatePolicy(PolicyDraft draft) {
    requireBetween("full refund days", draft.fullRefundDays(), 0, 365);
    requireBetween("partial refund percent", draft.partialRefundPercent(), 0, 100);
    requireBetween("weekend surcharge percent", draft.weekendSurchargePercent(), 0, 100);
    requireBetween("length-of-stay minimum nights", draft.losMinNights(), 1, 365);
    requireBetween("length-of-stay discount percent", draft.losDiscountPercent(), 0, 100);
  }

  private static void requireCode(String code) {
    if (code == null || !CODE.matcher(code).matches() || code.length() > 40) {
      throw new ValidationException(
          "codes are lower-case words joined by hyphens, up to 40 characters");
    }
  }

  private static void requireText(String field, String value) {
    if (value == null || value.isBlank() || value.length() > 120) {
      throw new ValidationException(field + " is required and at most 120 characters");
    }
  }

  private static void requireBetween(String field, int value, int min, int max) {
    if (value < min || value > max) {
      throw new ValidationException(field + " must be between " + min + " and " + max);
    }
  }

  private static void requireMoney(String field, BigDecimal amount, Currency currency) {
    if (amount == null || amount.signum() < 0) {
      throw new ValidationException(field + " cannot be negative");
    }
    if (amount.stripTrailingZeros().scale() > currency.getDefaultFractionDigits()) {
      throw new ValidationException(
          field + " has more decimals than " + currency.getCurrencyCode() + " allows");
    }
  }

  /** An IANA time zone name; fixed offsets such as {@code +01:00} or {@code UTC+1} are refused. */
  private static ZoneId zone(String id) {
    if (id == null || !ZoneId.getAvailableZoneIds().contains(id)) {
      throw new ValidationException(
          "time zone " + id + " is not an IANA zone name such as Europe/Lisbon");
    }
    return ZoneId.of(id);
  }

  private static Currency currency(String code) {
    Currency currency;
    try {
      currency = Currency.getInstance(code);
    } catch (IllegalArgumentException e) {
      throw new ValidationException("unknown currency " + code);
    }
    if (currency.getDefaultFractionDigits() > 2) {
      throw new ValidationException(
          "currency " + code + " has more than two minor units, which prices cannot hold");
    }
    return currency;
  }

  public Property updateDetails(
      String propertyCode,
      String name,
      String timeZone,
      LocalTime checkInTime,
      LocalTime checkOutTime) {
    requireText("name", name);
    if (checkInTime == null || checkOutTime == null) {
      throw new ValidationException("check-in and check-out times are required");
    }
    ZoneId zone = zone(timeZone);
    return tx.execute(
        status -> {
          Property property = property(propertyCode);
          property.changeDetails(name.trim(), zone, checkInTime, checkOutTime);
          return property;
        });
  }

  /** Sets the same total for every night of the range, check-in night included. */
  public int setInventoryRange(
      String propertyCode, String roomTypeCode, DateRange range, int total) {
    if (range.nights() > MAX_INVENTORY_NIGHTS) {
      throw new ValidationException("at most " + MAX_INVENTORY_NIGHTS + " nights at a time");
    }
    List<NightTotal> nights =
        range.nightDates().stream().map(night -> new NightTotal(night, total)).toList();
    return setInventory(propertyCode, roomTypeCode, nights);
  }
}
