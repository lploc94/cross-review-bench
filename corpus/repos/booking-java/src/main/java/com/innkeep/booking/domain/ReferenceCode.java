package com.innkeep.booking.domain;

import java.security.SecureRandom;

/**
 * Human-friendly reservation references such as {@code IK-7K2QM4PD}. The alphabet leaves out the
 * easily confused characters 0, O, 1, I, so guests can read a reference over the phone.
 */
public final class ReferenceCode {

  static final String PREFIX = "IK-";
  static final String ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  static final int LENGTH = 8;

  private ReferenceCode() {}

  public static String generate(SecureRandom random) {
    StringBuilder code = new StringBuilder(PREFIX);
    for (int i = 0; i < LENGTH; i++) {
      code.append(ALPHABET.charAt(random.nextInt(ALPHABET.length())));
    }
    return code.toString();
  }
}
