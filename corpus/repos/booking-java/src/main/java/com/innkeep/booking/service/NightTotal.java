package com.innkeep.booking.service;

import java.time.LocalDate;

/** One row of an admin inventory update: the sellable rooms for a night. */
public record NightTotal(LocalDate night, int total) {}
