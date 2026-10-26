/** One HTTP delivery of a signed event to one endpoint. */
export interface WebhookDelivery {
  readonly endpointId: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * Sends webhook deliveries. A delivery succeeds when the promise resolves; it rejects with a
 * WebhookDeliveryError for a non-2xx answer, a timeout or a network failure.
 */
export interface WebhookSender {
  send(delivery: WebhookDelivery): Promise<void>;
}

export class WebhookDeliveryError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options: { status?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "WebhookDeliveryError";
    this.status = options.status;
  }
}
