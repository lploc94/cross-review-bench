// Failure classes (I10): infra failures are retried and never scored; reviewer failures are scored.
//
//   ok                  a completed round with a verdict
//   infra               the runner or CLI could not do the review: missing CLI, runner error before the
//                       reviewer started, auth, usage limit, network, a reviewer process that died
//   reviewer_timeout    the runner deadline ended the round (retried once, then scored)
//   reviewer_stall      no output for ~3 minutes (retried once, then scored)
//   reviewer_malformed  the round completed without a verdict (scored)

const USAGE = /usage limit|rate[ -]?limit(ed)?\b|too many requests|\b429\b|quota (exceeded|exhausted)|exceeded (your |the )?quota|resource_exhausted|(at|over) capacity|overloaded_error/i;
const AUTH = /\b40[13] (unauthori[sz]ed|forbidden)|status:? 40[13]\b|\bunauthori[sz]ed\b|not logged in|please (run )?\/login|log ?in again|authentication (failed|error|required)|invalid[_ ]?(api[_ ]?key|grant)|token (expired|revoked|refresh failed)/i;
const NETWORK = /ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network error|fetch failed|stream (error|disconnected)|\b50[234] (service unavailable|bad gateway|gateway timeout)|service unavailable/i;

/** usage_limit, auth or network when the text reports one of them, else null. */
export function infraReason(text) {
  if (USAGE.test(text)) return "usage_limit";
  if (AUTH.test(text)) return "auth";
  if (NETWORK.test(text)) return "network";
  return null;
}

/**
 * Classify one attempt. Inputs: beginCode/beginJson (the `begin` result), waitJson (last `wait`
 * result, null when wait failed), errorLog (reviewer stderr and harness errors). Returns { class, reason }.
 */
export function classify({ beginCode = 0, beginJson = null, waitJson = null, errorLog = "" } = {}) {
  if (beginCode !== 0 || beginJson?.status === "error") {
    if (beginCode === 5 || beginJson?.code === "REVIEWER_NOT_FOUND") return { class: "infra", reason: "reviewer_not_found" };
    const why = infraReason(`${beginJson?.error ?? ""}\n${errorLog}`);
    return { class: "infra", reason: why ?? "begin_failed" };
  }
  if (!waitJson) return { class: "infra", reason: "wait_failed" };

  const review = waitJson.review ?? null;
  const verdict = review?.verdict?.status ?? null;
  if (waitJson.status === "completed" && verdict) return { class: "ok", reason: verdict.toLowerCase() };

  // the deadline and the stall watchdog are the reviewer's own time; CLI stderr is too noisy to overrule them
  if (waitJson.status === "timeout") return { class: "reviewer_timeout", reason: waitJson.timeout_reason ?? "timeout" };
  if (waitJson.status === "stalled") return { class: "reviewer_stall", reason: "stalled" };

  // findings mean the reviewer did review; their text (about rate limits, 401s, …) is not a CLI fault
  if (waitJson.status === "completed" && review?.blocks?.length) return { class: "reviewer_malformed", reason: "missing_verdict" };

  const text = [waitJson.error, review?.raw_markdown, errorLog].filter(Boolean).join("\n");
  const why = infraReason(text);
  if (why) return { class: "infra", reason: why };
  if (waitJson.status === "completed") return { class: "reviewer_malformed", reason: "missing_verdict" };
  return { class: "infra", reason: waitJson.failure_reason ?? waitJson.status ?? "unknown" };
}

export const REVIEWER_FAILURES = ["reviewer_timeout", "reviewer_stall", "reviewer_malformed"];
