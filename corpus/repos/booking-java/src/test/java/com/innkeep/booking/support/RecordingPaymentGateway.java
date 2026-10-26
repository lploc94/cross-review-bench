package com.innkeep.booking.support;

import com.innkeep.booking.domain.Money;
import com.innkeep.booking.domain.PaymentFailedException;
import com.innkeep.booking.service.PaymentGateway;
import java.util.ArrayList;
import java.util.List;

/** An in-memory gateway that records every movement, so tests can count money moved. */
public class RecordingPaymentGateway implements PaymentGateway {

  public record Movement(String kind, String key, Money amount) {}

  private final List<Movement> movements = new ArrayList<>();
  private boolean failNextCharge;
  private Runnable beforeNextCharge;

  @Override
  public String charge(String idempotencyKey, Money amount) {
    Runnable hook = takeHook();
    if (hook != null) {
      hook.run();
    }
    return recordCharge(idempotencyKey, amount);
  }

  @Override
  public synchronized String refund(String idempotencyKey, Money amount) {
    movements.add(new Movement("refund", idempotencyKey, amount));
    return "rec:" + idempotencyKey;
  }

  public synchronized void failNextCharge() {
    this.failNextCharge = true;
  }

  /** Runs once, before the next charge is recorded and outside this gateway's lock. */
  public synchronized void beforeNextCharge(Runnable hook) {
    this.beforeNextCharge = hook;
  }

  public synchronized List<Movement> movements() {
    return List.copyOf(movements);
  }

  public synchronized long refundCount() {
    return movements.stream().filter(m -> m.kind().equals("refund")).count();
  }

  public synchronized void reset() {
    movements.clear();
    failNextCharge = false;
    beforeNextCharge = null;
  }

  private synchronized Runnable takeHook() {
    Runnable hook = beforeNextCharge;
    beforeNextCharge = null;
    return hook;
  }

  private synchronized String recordCharge(String idempotencyKey, Money amount) {
    if (failNextCharge) {
      failNextCharge = false;
      throw new PaymentFailedException("declined", null);
    }
    movements.add(new Movement("charge", idempotencyKey, amount));
    return "rec:" + idempotencyKey;
  }
}
