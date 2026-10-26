package com.innkeep.booking.service;

import java.math.BigDecimal;
import java.time.LocalDate;

/** One night of a whole property: rooms set, held, booked, and the share of rooms in use. */
public record OccupancyDay(
    LocalDate night, int totalRooms, int heldRooms, int bookedRooms, BigDecimal percentInUse) {}
