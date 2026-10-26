package core

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/health"
	"github.com/relaywork/gateway/internal/metrics"
)

// Runtime owns the live route table. Apply builds a table from a validated routes file and
// swaps it in atomically; requests in flight keep the table they started with.
//
// Per-upstream state survives a reload when the route keeps the upstream: its circuit breaker
// when the breaker settings are unchanged, and its health and health checker when the health
// check settings are unchanged. Everything else starts fresh.
type Runtime struct {
	clock        clock.Clock
	log          *slog.Logger
	healthClient *http.Client
	gauges       runtimeGauges

	table atomic.Pointer[Table]

	mu     sync.Mutex // serialises Apply and Close
	states map[stateKey]*upstreamState
	closed bool
}

// stateKey identifies an upstream of a route across reloads.
type stateKey struct {
	route    string
	upstream string
}

// upstreamState is what a route's upstream keeps across reloads.
type upstreamState struct {
	breaker     *Breaker
	breakerSpec *config.CircuitBreaker
	health      *Health
	healthSpec  *config.HealthCheck
	stop        func() // stops the health checker; nil without one
}

type runtimeGauges struct {
	breaker  *metrics.Gauge
	healthy  *metrics.Gauge
	checks   *metrics.Counter
	routes   *metrics.Gauge
	reloads  *metrics.Counter
	lastLoad *metrics.Gauge
}

// RuntimeOptions configure a Runtime.
type RuntimeOptions struct {
	Clock   clock.Clock
	Logger  *slog.Logger
	Metrics *metrics.Registry // optional
	// HealthTransport sends health check requests. nil means a dedicated http.Transport.
	HealthTransport http.RoundTripper
}

// NewRuntime returns a runtime with an empty table. Call Apply to load routes.
func NewRuntime(o RuntimeOptions) (*Runtime, error) {
	if o.Clock == nil || o.Logger == nil {
		return nil, errors.New("core: Clock and Logger are required")
	}
	reg := o.Metrics
	if reg == nil {
		reg = metrics.NewRegistry()
	}
	transport := o.HealthTransport
	if transport == nil {
		transport = &http.Transport{Proxy: nil, MaxIdleConnsPerHost: 2, IdleConnTimeout: time.Minute}
	}
	rt := &Runtime{
		clock: o.Clock,
		log:   o.Logger,
		healthClient: &http.Client{
			Transport: transport,
			// A redirect answers the health check; following it would check something else.
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		gauges: runtimeGauges{
			breaker: reg.NewGauge("gateway_circuit_breaker_state",
				"Circuit breaker state per route and upstream: 0 closed, 1 open, 2 half-open.", "route", "upstream"),
			healthy: reg.NewGauge("gateway_upstream_healthy",
				"1 when active health checks consider the upstream healthy, 0 otherwise.", "route", "upstream"),
			checks: reg.NewCounter("gateway_health_checks_total",
				"Active health check probes by result.", "route", "upstream", "result"),
			routes:   reg.NewGauge("gateway_routes", "Routes in the live table."),
			reloads:  reg.NewCounter("gateway_route_reloads_total", "Route table loads by result.", "result"),
			lastLoad: reg.NewGauge("gateway_route_table_loaded_timestamp_seconds", "When the live route table was loaded, as a Unix time."),
		},
		states: make(map[stateKey]*upstreamState),
	}
	rt.table.Store(newTable(nil))
	return rt, nil
}

// Table returns the live route table.
func (rt *Runtime) Table() *Table { return rt.table.Load() }

// Reload loads the routes file at path and applies it. When the file is unreadable or invalid,
// the live table stays as it is and the error says why.
func (rt *Runtime) Reload(path string) error {
	routes, err := config.LoadRoutes(path)
	if err != nil {
		rt.gauges.reloads.Inc("invalid")
		return err
	}
	return rt.Apply(routes)
}

// Apply builds a table from routes, which must have been validated by config.ParseRoutes, and
// makes it live. Health checkers of new upstreams start before the swap; those of removed
// upstreams stop after it.
func (rt *Runtime) Apply(routes *config.Routes) error {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.closed {
		return errors.New("core: runtime is closed")
	}

	next := make(map[stateKey]*upstreamState)
	var started []stateKey
	built := make([]*Route, 0, len(routes.Routes))
	for _, spec := range routes.Routes {
		r, err := rt.buildRoute(spec, next, &started)
		if err != nil {
			for _, key := range started {
				next[key].stop()
				if rt.states[key] == nil {
					rt.gauges.healthy.Delete(key.route, key.upstream)
				}
			}
			rt.gauges.reloads.Inc("invalid")
			return fmt.Errorf("route %q: %w", spec.ID, err)
		}
		built = append(built, r)
	}

	rt.table.Store(newTable(built))

	for key, cur := range next {
		old := rt.states[key]
		switch {
		case cur.breaker == nil:
			rt.gauges.breaker.Delete(key.route, key.upstream)
		case old == nil || old.breaker != cur.breaker:
			rt.gauges.breaker.Set(float64(cur.breaker.State()), key.route, key.upstream)
		}
		if cur.healthSpec == nil {
			rt.gauges.healthy.Delete(key.route, key.upstream)
		}
	}
	for key, old := range rt.states {
		cur, kept := next[key]
		if old.stop != nil && (!kept || cur.health != old.health) {
			old.stop()
		}
		if !kept {
			rt.gauges.breaker.Delete(key.route, key.upstream)
			rt.gauges.healthy.Delete(key.route, key.upstream)
		}
	}
	rt.states = next
	rt.gauges.routes.Set(float64(len(built)))
	rt.gauges.reloads.Inc("ok")
	rt.gauges.lastLoad.Set(float64(rt.clock.Now().Unix()))
	rt.log.Info("route table loaded", "routes", len(built), "upstreams", len(next))
	return nil
}

// buildRoute compiles one route into next, reusing the state of upstreams it already had. New
// health checkers are started and their keys appended to started.
func (rt *Runtime) buildRoute(spec config.Route, next map[stateKey]*upstreamState, started *[]stateKey) (*Route, error) {
	path, prefix := spec.MatchPath()
	r := &Route{
		ID:          spec.ID,
		Host:        spec.Host,
		Path:        path,
		Prefix:      prefix,
		Methods:     slices.Clone(spec.Methods),
		StripPrefix: spec.StripPrefix,
		Timeout:     spec.Timeout.D(),
		Auth:        spec.Auth,
		Retry:       retryPolicy(spec.Retry),
		spec:        spec,
	}
	if len(r.Methods) == 0 {
		r.Methods = nil
	}
	if spec.RateLimit != nil {
		r.RateLimit = &RateLimitPolicy{Requests: spec.RateLimit.Requests, Window: spec.RateLimit.Window.D()}
	}
	if t := spec.Transforms; t != nil {
		r.Request = compileTransform(t.Request)
		r.Response = compileTransform(t.Response)
	}
	for _, us := range spec.Upstreams {
		u, err := url.Parse(us.URL)
		if err != nil {
			return nil, fmt.Errorf("upstream %q: %w", us.URL, err)
		}
		key := stateKey{route: spec.ID, upstream: u.String()}
		st := rt.upstreamState(key, spec)
		next[key] = st
		if spec.HealthCheck != nil && st.stop == nil {
			stop, err := rt.startChecker(key, u, *spec.HealthCheck, st.health)
			if err != nil {
				return nil, err
			}
			st.stop = stop
			*started = append(*started, key)
		}
		r.Upstreams = append(r.Upstreams, &Upstream{
			RouteID: spec.ID,
			URL:     u,
			Weight:  us.Weight,
			Breaker: st.breaker,
			health:  st.health,
		})
	}
	r.balancer = NewBalancer(r.Upstreams)
	return r, nil
}

// upstreamState returns the state for key under spec: the current parts where their settings
// are unchanged, fresh parts otherwise. It never modifies the current state, so that a failed
// Apply leaves the live table untouched.
func (rt *Runtime) upstreamState(key stateKey, spec config.Route) *upstreamState {
	old := rt.states[key]
	st := &upstreamState{breakerSpec: spec.CircuitBreaker, healthSpec: spec.HealthCheck}
	if spec.CircuitBreaker != nil {
		if old != nil && old.breakerSpec != nil && *old.breakerSpec == *spec.CircuitBreaker {
			st.breaker = old.breaker
		} else {
			st.breaker = NewBreaker(breakerPolicy(*spec.CircuitBreaker), rt.clock, func(from, to BreakerState) {
				rt.gauges.breaker.Set(float64(to), key.route, key.upstream)
				rt.log.Warn("circuit breaker changed state", "route", key.route, "upstream", key.upstream,
					"from", from.String(), "to", to.String())
			})
		}
	}
	if old != nil && sameHealthCheck(old.healthSpec, spec.HealthCheck) {
		st.health, st.stop = old.health, old.stop
	} else {
		st.health = &Health{}
	}
	return st
}

func sameHealthCheck(a, b *config.HealthCheck) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

// startChecker starts the health checker of a new upstream. The health gauge is set before the
// checker starts, so that the checker's first report cannot be overwritten.
func (rt *Runtime) startChecker(key stateKey, target *url.URL, hc config.HealthCheck, h *Health) (func(), error) {
	rt.gauges.healthy.Set(1, key.route, key.upstream)
	c := &health.Checker{
		Target:             target,
		Path:               hc.Path,
		Interval:           hc.Interval.D(),
		Timeout:            hc.Timeout.D(),
		HealthyThreshold:   hc.HealthyThreshold,
		UnhealthyThreshold: hc.UnhealthyThreshold,
		Client:             rt.healthClient,
		Clock:              rt.clock,
		Logger:             rt.log.With("route", key.route),
		Report: func(healthy bool) {
			h.Set(healthy)
			v := 0.0
			if healthy {
				v = 1
			}
			rt.gauges.healthy.Set(v, key.route, key.upstream)
		},
		Observe: func(ok bool) {
			result := "failure"
			if ok {
				result = "success"
			}
			rt.gauges.checks.Inc(key.route, key.upstream, result)
		},
	}
	return c.Start()
}

// Close stops every health checker. The table stays readable.
func (rt *Runtime) Close() {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	if rt.closed {
		return
	}
	rt.closed = true
	for _, st := range rt.states {
		if st.stop != nil {
			st.stop()
		}
	}
}

// UpstreamStatus describes an upstream for the admin API.
type UpstreamStatus struct {
	URL     string `json:"url"`
	Weight  int    `json:"weight"`
	Healthy bool   `json:"healthy"`
	Breaker string `json:"breaker,omitempty"`
}

// Status returns the health and breaker state of a route's upstreams.
func (r *Route) Status() []UpstreamStatus {
	out := make([]UpstreamStatus, len(r.Upstreams))
	for i, u := range r.Upstreams {
		out[i] = UpstreamStatus{URL: u.String(), Weight: u.Weight, Healthy: u.Healthy()}
		if u.Breaker != nil {
			out[i].Breaker = u.Breaker.State().String()
		}
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}
