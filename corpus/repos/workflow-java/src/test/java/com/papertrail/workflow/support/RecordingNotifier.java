package com.papertrail.workflow.support;

import com.papertrail.workflow.integration.NotificationMessage;
import com.papertrail.workflow.integration.Notifier;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Records every delivered message. Failures can be scripted: a failed delivery records nothing,
 * while a lost acknowledgement records the message and then reports an error, the case where a
 * redelivery produces a duplicate.
 */
public class RecordingNotifier implements Notifier {

  private final List<NotificationMessage> delivered = new CopyOnWriteArrayList<>();
  private final AtomicInteger failures = new AtomicInteger();
  private final AtomicInteger lostAcknowledgements = new AtomicInteger();

  @Override
  public void send(NotificationMessage message) {
    if (take(failures)) {
      throw new IllegalStateException("provider unavailable");
    }
    delivered.add(message);
    if (take(lostAcknowledgements)) {
      throw new IllegalStateException("acknowledgement lost");
    }
  }

  public List<NotificationMessage> delivered() {
    return List.copyOf(delivered);
  }

  public void failNextDeliveries(int count) {
    failures.set(count);
  }

  public void loseNextAcknowledgements(int count) {
    lostAcknowledgements.set(count);
  }

  public void reset() {
    delivered.clear();
    failures.set(0);
    lostAcknowledgements.set(0);
  }

  private static boolean take(AtomicInteger counter) {
    return counter.getAndUpdate(value -> value > 0 ? value - 1 : 0) > 0;
  }
}
