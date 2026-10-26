package store

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/relaywork/gateway/internal/core"
)

// counterGrace is added to a rate-limit counter's lifetime. The counter's key names its window,
// so the expiry only reclaims memory; the grace lets a gateway whose clock lags slightly behind
// another's still find the counter of the window it is in.
const counterGrace = time.Second

// fixedWindowScript counts one request in a fixed window. The first request of the window
// creates the counter and sets its expiry, in the same atomic step.
// KEYS: the window's counter. ARGV: the counter's lifetime in milliseconds.
var fixedWindowScript = redis.NewScript(`
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`)

// FixedWindowLimiter counts requests per route and consumer in fixed windows aligned to the Unix
// epoch: with a one-minute window, every minute starts a fresh count. It implements
// core.RateLimiter.
type FixedWindowLimiter struct {
	s *Store
}

// FixedWindow returns a fixed-window rate limiter that keeps its counters in s.
func (s *Store) FixedWindow() *FixedWindowLimiter { return &FixedWindowLimiter{s: s} }

// Allow counts one request and reports whether it is within the policy. The current time comes
// from the store's clock, never from Redis, so that every gateway agrees on window boundaries
// with its own clock and tests can control them.
func (l *FixedWindowLimiter) Allow(ctx context.Context, route, consumer string, p core.RateLimitPolicy) (core.RateLimitDecision, error) {
	nowMS := l.s.clock.Now().UnixMilli()
	windowMS := p.Window.Milliseconds()
	if windowMS <= 0 || p.Requests < 1 {
		return core.RateLimitDecision{}, fmt.Errorf("rate limit: invalid policy %+v", p)
	}
	start := nowMS - nowMS%windowMS
	end := start + windowMS
	ttl := end - nowMS + counterGrace.Milliseconds()

	count, err := fixedWindowScript.Run(ctx, l.s.rdb, []string{l.s.rateLimitKey(route, consumer, start)}, ttl).Int64()
	if err != nil {
		return core.RateLimitDecision{}, fmt.Errorf("rate limit: %w", err)
	}
	d := core.RateLimitDecision{
		Allowed: count <= int64(p.Requests),
		Limit:   p.Requests,
		Reset:   time.Duration(end-nowMS) * time.Millisecond,
	}
	if d.Allowed {
		d.Remaining = p.Requests - int(count)
	}
	return d, nil
}
