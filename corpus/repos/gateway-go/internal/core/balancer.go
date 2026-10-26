package core

import (
	"net/url"
	"sync"
	"sync/atomic"
)

// Upstream is one backend of a route. Its breaker and health state outlive reloads that keep
// the route's upstream with the same settings.
type Upstream struct {
	RouteID string
	URL     *url.URL
	Weight  int
	Breaker *Breaker // nil when the route has no circuit breaker
	health  *Health
}

// Healthy reports whether active health checks consider the upstream healthy. Upstreams without
// health checks are always healthy.
func (u *Upstream) Healthy() bool { return u.health.Healthy() }

// String returns the upstream's URL.
func (u *Upstream) String() string { return u.URL.String() }

// Health is the health of an upstream as seen by its active checker. A new upstream starts
// healthy, so that traffic flows before the first check completes.
type Health struct {
	unhealthy atomic.Bool
}

// Healthy reports the current health.
func (h *Health) Healthy() bool { return !h.unhealthy.Load() }

// Set records the outcome of the checker's thresholds.
func (h *Health) Set(healthy bool) { h.unhealthy.Store(!healthy) }

// Balancer spreads requests over a route's upstreams by smooth weighted round-robin: over any
// run of picks, each upstream gets its share by weight, and heavier upstreams are interleaved
// with lighter ones rather than picked in bursts.
type Balancer struct {
	mu        sync.Mutex
	upstreams []*Upstream
	current   []int
}

// NewBalancer returns a balancer over upstreams.
func NewBalancer(upstreams []*Upstream) *Balancer {
	return &Balancer{upstreams: upstreams, current: make([]int, len(upstreams))}
}

// Next returns the next healthy upstream for which skip returns false, or nil when there is
// none. A nil skip skips nothing but unhealthy upstreams.
func (b *Balancer) Next(skip func(*Upstream) bool) *Upstream {
	b.mu.Lock()
	defer b.mu.Unlock()
	total, best := 0, -1
	for i, u := range b.upstreams {
		if !u.Healthy() || (skip != nil && skip(u)) {
			continue
		}
		b.current[i] += u.Weight
		total += u.Weight
		if best < 0 || b.current[i] > b.current[best] {
			best = i
		}
	}
	if best < 0 {
		return nil
	}
	b.current[best] -= total
	return b.upstreams[best]
}
