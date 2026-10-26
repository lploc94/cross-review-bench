package com.innkeep.booking.persistence;

/**
 * Per room type over a date range: the fewest rooms free on any night and how many nights have an
 * inventory row at all. A room type with fewer rows than nights has no rooms for some night.
 */
public record RoomAvailability(long roomTypeId, int minAvailable, long nightCount) {}
