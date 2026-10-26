import {
  WebhookDeliveryError,
  type WebhookDelivery,
  type WebhookSender,
} from "../../src/services/webhookSender.js";

export interface RecordedDelivery extends WebhookDelivery {
  readonly event: { id: string; type: string; created_at: string; data: unknown };
}

/** Records every delivery; URLs listed in `failing` answer like an endpoint returning 500. */
export class FakeWebhookSender implements WebhookSender {
  readonly deliveries: RecordedDelivery[] = [];
  readonly attempts: WebhookDelivery[] = [];
  private readonly failing = new Set<string>();

  failFor(url: string): void {
    this.failing.add(url);
  }

  recover(url: string): void {
    this.failing.delete(url);
  }

  async send(delivery: WebhookDelivery): Promise<void> {
    this.attempts.push(delivery);
    if (this.failing.has(delivery.url)) {
      throw new WebhookDeliveryError("endpoint answered HTTP 500", { status: 500 });
    }
    this.deliveries.push({
      ...delivery,
      event: JSON.parse(delivery.body) as RecordedDelivery["event"],
    });
  }

  eventTypes(): string[] {
    return this.deliveries.map((delivery) => delivery.event.type);
  }
}
