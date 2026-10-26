package com.innkeep.booking.service;

import java.math.BigDecimal;

public record RoomTypeDraft(
    String code, String name, int capacity, BigDecimal baseNightlyRate, BigDecimal extraGuestFee) {}
