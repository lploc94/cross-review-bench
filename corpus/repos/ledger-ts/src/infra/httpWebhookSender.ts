import {
  WebhookDeliveryError,
  type WebhookDelivery,
  type WebhookSender,
} from "../services/webhookSender.js";

/** WebhookSender over HTTP: a POST per delivery, aborted after `timeoutMs`. */
export class HttpWebhookSender implements WebhookSender {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { timeoutMs: number; fetchImpl?: typeof fetch }) {
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async send(delivery: WebhookDelivery): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(delivery.url, {
        method: "POST",
        headers: { "content-type": "application/json", ...delivery.headers },
        body: delivery.body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err instanceof DOMException && err.name === "TimeoutError";
      throw new WebhookDeliveryError(
        timedOut ? `timed out after ${this.timeoutMs} ms` : `request failed: ${describe(err)}`,
        { cause: err },
      );
    }
    // The answer's body is not used; discard it so the connection can be reused.
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 200 || response.status > 299) {
      throw new WebhookDeliveryError(`endpoint answered HTTP ${response.status}`, {
        status: response.status,
      });
    }
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}
