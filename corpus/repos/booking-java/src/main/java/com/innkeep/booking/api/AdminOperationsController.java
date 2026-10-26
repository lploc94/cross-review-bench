package com.innkeep.booking.api;

import com.innkeep.booking.api.dto.HoldSummary;
import com.innkeep.booking.api.dto.LedgerResponse;
import com.innkeep.booking.api.dto.PageResponse;
import com.innkeep.booking.api.dto.ReservationResponse;
import com.innkeep.booking.api.dto.ReservationSummary;
import com.innkeep.booking.domain.DateRange;
import com.innkeep.booking.domain.HoldStatus;
import com.innkeep.booking.domain.ReservationStatus;
import com.innkeep.booking.service.BookingMaintenanceJob;
import com.innkeep.booking.service.HoldService;
import com.innkeep.booking.service.MaintenanceReport;
import com.innkeep.booking.service.NetRevenue;
import com.innkeep.booking.service.OperationsService;
import com.innkeep.booking.service.ReservationService;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import java.time.LocalDate;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.data.domain.PageRequest;
import org.springframework.format.annotation.DateTimeFormat;
import org.springframework.validation.annotation.Validated;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** Admin views over holds and reservations, and a manual run of the housekeeping job. */
@Validated
@RestController
@RequestMapping("/api/v1/admin")
public class AdminOperationsController {

  private final HoldService holds;
  private final OperationsService operations;
  private final ReservationService reservations;
  private final BookingMaintenanceJob maintenance;

  public AdminOperationsController(
      HoldService holds,
      OperationsService operations,
      ReservationService reservations,
      BookingMaintenanceJob maintenance) {
    this.holds = holds;
    this.operations = operations;
    this.reservations = reservations;
    this.maintenance = maintenance;
  }

  @GetMapping("/holds")
  public PageResponse<HoldSummary> holds(
      @RequestParam(defaultValue = "ACTIVE") HoldStatus status,
      @RequestParam(required = false) String property,
      @RequestParam(defaultValue = "0") @Min(0) int page,
      @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
    return PageResponse.from(
        holds.list(status, property, PageRequest.of(page, size)), HoldSummary::from);
  }

  @GetMapping("/properties/{code}/arrivals")
  public List<ReservationSummary> arrivals(
      @PathVariable String code,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
    return operations.arrivals(code, date).stream().map(ReservationSummary::from).toList();
  }

  @GetMapping("/properties/{code}/departures")
  public List<ReservationSummary> departures(
      @PathVariable String code,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
    return operations.departures(code, date).stream().map(ReservationSummary::from).toList();
  }

  @GetMapping("/properties/{code}/in-house")
  public List<ReservationSummary> inHouse(
      @PathVariable String code,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate date) {
    return operations.inHouse(code, date).stream().map(ReservationSummary::from).toList();
  }

  @GetMapping("/properties/{code}/revenue")
  public NetRevenue revenue(
      @PathVariable String code,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
      @RequestParam @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to) {
    return operations.netRevenue(code, new DateRange(from, to));
  }

  @GetMapping("/reservations")
  public PageResponse<ReservationSummary> reservations(
      @RequestParam(required = false) String property,
      @RequestParam(required = false) ReservationStatus status,
      @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate from,
      @RequestParam(required = false) @DateTimeFormat(iso = DateTimeFormat.ISO.DATE) LocalDate to,
      @RequestParam(required = false) String guestEmail,
      @RequestParam(required = false) String guestName,
      @RequestParam(defaultValue = "0") @Min(0) int page,
      @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
    return PageResponse.from(
        reservations.search(
            property, status, from, to, guestEmail, guestName, PageRequest.of(page, size)),
        ReservationSummary::from);
  }

  @GetMapping("/reservations/{reference}/ledger")
  public LedgerResponse ledger(@PathVariable String reference) {
    return LedgerResponse.from(reservations.ledger(reference));
  }

  @PostMapping("/reservations/{reference}/check-in")
  public ReservationResponse checkIn(@PathVariable String reference) {
    return ReservationResponse.from(reservations.checkIn(reference));
  }

  @GetMapping("/reservations/summary")
  public Map<ReservationStatus, Long> reservationSummary() {
    return reservations.countByStatus();
  }

  @GetMapping("/holds/summary")
  public Map<HoldStatus, Long> holdSummary() {
    return holds.countByStatus();
  }

  @PostMapping("/holds/{id}/expire")
  public HoldSummary expireHold(@PathVariable UUID id) {
    return HoldSummary.from(holds.expireNow(id));
  }

  @PostMapping("/maintenance/run")
  public MaintenanceReport runMaintenance() {
    return maintenance.run();
  }
}
