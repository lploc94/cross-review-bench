package core

import (
	"context"
	"net/http"
	"time"

	"github.com/relaywork/gateway/internal/config"
)

// ErrorClass classifies a failed attempt that produced no response.
type ErrorClass string

// Error classes, as named in the routes file.
const (
	ErrConnect ErrorClass = config.RetryOnConnect
	ErrTimeout ErrorClass = config.RetryOnTimeout
	ErrReset   ErrorClass = config.RetryOnReset
)

// RetryPolicy says when a failed attempt is tried again.
type RetryPolicy struct {
	Attempts      int // total attempts; 1 means no retry
	Statuses      map[int]bool
	Errors        map[ErrorClass]bool
	Backoff       time.Duration
	MaxBackoff    time.Duration
	NonIdempotent bool
}

func retryPolicy(c *config.Retry) RetryPolicy {
	if c == nil {
		return RetryPolicy{Attempts: 1}
	}
	p := RetryPolicy{
		Attempts:      c.Attempts,
		Statuses:      make(map[int]bool, len(c.OnStatus)),
		Errors:        make(map[ErrorClass]bool, len(c.OnErrors)),
		Backoff:       c.Backoff.D(),
		MaxBackoff:    c.MaxBackoff.D(),
		NonIdempotent: c.NonIdempotent,
	}
	for _, s := range c.OnStatus {
		p.Statuses[s] = true
	}
	for _, e := range c.OnErrors {
		p.Errors[ErrorClass(e)] = true
	}
	return p
}

// IsIdempotent reports whether repeating a request with method has the same effect as sending
// it once (RFC 9110 section 9.2.2).
func IsIdempotent(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodPut, http.MethodDelete:
		return true
	}
	return false
}

// Retries reports whether requests with method may be retried at all under the policy.
func (p RetryPolicy) Retries(method string) bool {
	return p.Attempts > 1 && (IsIdempotent(method) || p.NonIdempotent)
}

// RetryStatus reports whether an upstream response with status should be retried.
func (p RetryPolicy) RetryStatus(status int) bool { return p.Statuses[status] }

// RetryError reports whether an attempt that failed with class should be retried.
func (p RetryPolicy) RetryError(class ErrorClass) bool { return p.Errors[class] }

// Rand is a source of randomness for backoff jitter. *math/rand/v2.Rand satisfies it; the
// gateway uses the safe top-level functions of math/rand/v2.
type Rand interface {
	// Int64N returns a number in [0, n). n is positive.
	Int64N(n int64) int64
}

// Delay returns how long to wait before retry number n (1 for the first retry): exponential
// backoff from Backoff, capped at MaxBackoff, with "equal jitter" (half fixed, half random) so
// that clients retrying together spread out.
func (p RetryPolicy) Delay(n int, rnd Rand) time.Duration {
	if p.Backoff <= 0 || n < 1 {
		return 0
	}
	d := p.Backoff
	for i := 1; i < n && d < p.MaxBackoff; i++ {
		d *= 2
	}
	d = min(d, p.MaxBackoff)
	half := d / 2
	return half + time.Duration(rnd.Int64N(int64(d-half)+1))
}

// RateLimitPolicy allows Requests per Window to each consumer of a route.
type RateLimitPolicy struct {
	Requests int
	Window   time.Duration
}

// RateLimitDecision is a limiter's answer for one request.
type RateLimitDecision struct {
	Allowed   bool
	Limit     int
	Remaining int           // requests left in the current window after this one
	Reset     time.Duration // until the current window ends
}

// RateLimiter counts requests per route and consumer.
type RateLimiter interface {
	// Allow counts one request of consumer on route against policy.
	Allow(ctx context.Context, route, consumer string, policy RateLimitPolicy) (RateLimitDecision, error)
}
