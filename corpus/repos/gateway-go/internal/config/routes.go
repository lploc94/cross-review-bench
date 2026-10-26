package config

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"time"
)

// maxRoutesFileBytes bounds the routes file; a file this large is a mistake, not a route table.
const maxRoutesFileBytes = 8 << 20

// Authentication modes a route can require.
const (
	AuthNone   = "none"
	AuthAPIKey = "api_key"
	AuthHMAC   = "hmac"
)

// Transport error classes a retry policy can name.
const (
	RetryOnConnect = "connect" // the upstream could not be reached
	RetryOnTimeout = "timeout" // the upstream did not answer within the route's timeout
	RetryOnReset   = "reset"   // the connection broke before the response headers arrived
)

// Defaults for optional route settings.
const (
	DefaultTimeout             = 30 * time.Second
	DefaultRetryAttempts       = 3
	DefaultRetryBackoff        = 50 * time.Millisecond
	DefaultRetryMaxBackoff     = time.Second
	DefaultBreakerFailureRatio = 0.5
	DefaultBreakerMinRequests  = 10
	DefaultBreakerWindow       = 20
	DefaultBreakerOpenDuration = 30 * time.Second
	DefaultBreakerProbes       = 1
	DefaultHealthPath          = "/healthz"
	DefaultHealthInterval      = 10 * time.Second
	DefaultHealthTimeout       = 2 * time.Second
	DefaultHealthyThreshold    = 2
	DefaultUnhealthyThreshold  = 3
)

// DefaultRetryStatuses are the upstream status codes retried when a retry policy names none.
var DefaultRetryStatuses = []int{502, 503, 504}

// DefaultRetryErrors are the transport errors retried when a retry policy names none.
var DefaultRetryErrors = []string{RetryOnConnect, RetryOnTimeout, RetryOnReset}

// Routes is the parsed and validated routes file.
type Routes struct {
	Routes []Route `json:"routes"`
}

// Route is one entry of the routes file. A route matches requests by host, path and method,
// and says where and how to forward them.
type Route struct {
	ID         string   `json:"id"`
	Host       string   `json:"host,omitempty"`        // matched against the request host, port ignored
	Path       string   `json:"path,omitempty"`        // exact path match
	PathPrefix string   `json:"path_prefix,omitempty"` // prefix match on whole path segments
	Methods    []string `json:"methods,omitempty"`     // empty means every method

	Upstreams   []Upstream `json:"upstreams"`
	StripPrefix bool       `json:"strip_prefix,omitempty"`
	Timeout     Duration   `json:"timeout,omitempty"` // per attempt, until the response headers arrive
	Auth        string     `json:"auth,omitempty"`

	RateLimit      *RateLimit      `json:"rate_limit,omitempty"`
	Retry          *Retry          `json:"retry,omitempty"`
	CircuitBreaker *CircuitBreaker `json:"circuit_breaker,omitempty"`
	HealthCheck    *HealthCheck    `json:"health_check,omitempty"`
	Transforms     *Transforms     `json:"transforms,omitempty"`
}

// Upstream is one backend of a route.
type Upstream struct {
	URL    string `json:"url"`
	Weight int    `json:"weight,omitempty"`
}

// RateLimit allows Requests per Window to each consumer of the route.
type RateLimit struct {
	Requests int      `json:"requests"`
	Window   Duration `json:"window"`
}

// Retry says when a failed attempt is tried again on the next upstream.
type Retry struct {
	Attempts      int      `json:"attempts"` // total attempts, the first one included
	OnStatus      []int    `json:"on_status,omitempty"`
	OnErrors      []string `json:"on_errors,omitempty"`
	Backoff       Duration `json:"backoff,omitempty"`
	MaxBackoff    Duration `json:"max_backoff,omitempty"`
	NonIdempotent bool     `json:"non_idempotent,omitempty"` // also retry POST and PATCH
}

// CircuitBreaker opens when FailureRatio of the last Window outcomes failed, once at least
// MinRequests outcomes are recorded.
type CircuitBreaker struct {
	FailureRatio   float64  `json:"failure_ratio,omitempty"`
	MinRequests    int      `json:"min_requests,omitempty"`
	Window         int      `json:"window,omitempty"`
	OpenDuration   Duration `json:"open_duration,omitempty"`
	HalfOpenProbes int      `json:"half_open_probes,omitempty"`
}

// HealthCheck probes each upstream of the route.
type HealthCheck struct {
	Path               string   `json:"path"`
	Interval           Duration `json:"interval,omitempty"`
	Timeout            Duration `json:"timeout,omitempty"`
	HealthyThreshold   int      `json:"healthy_threshold,omitempty"`
	UnhealthyThreshold int      `json:"unhealthy_threshold,omitempty"`
}

// Transforms change the headers of forwarded requests and of the responses returned to clients.
type Transforms struct {
	Request  *HeaderTransform `json:"request,omitempty"`
	Response *HeaderTransform `json:"response,omitempty"`
}

// HeaderTransform renames, then removes, then adds header fields. Add replaces any value the
// field already has.
type HeaderTransform struct {
	Add    map[string]string `json:"add,omitempty"`
	Remove []string          `json:"remove,omitempty"`
	Rename map[string]string `json:"rename,omitempty"`

	dupes []string // names given twice in different spellings, found by normalize
}

// Duration is a time.Duration written in the routes file as a string such as "250ms" or "1m".
type Duration time.Duration

// D returns d as a time.Duration.
func (d Duration) D() time.Duration { return time.Duration(d) }

// MarshalJSON writes d as a duration string.
func (d Duration) MarshalJSON() ([]byte, error) {
	return json.Marshal(time.Duration(d).String())
}

// UnmarshalJSON reads a duration string.
func (d *Duration) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err != nil {
		return errors.New("must be a duration string such as \"30s\"")
	}
	v, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("must be a duration string such as \"30s\", got %q", s)
	}
	*d = Duration(v)
	return nil
}

// RouteError is a problem with one field of one route.
type RouteError struct {
	Route   string // the route's id, or "routes[i]" when it has none
	Field   string // e.g. "upstreams[1].url"
	Message string
}

func (e *RouteError) Error() string {
	if e.Field == "" {
		return e.Route + ": " + e.Message
	}
	return e.Route + ": " + e.Field + ": " + e.Message
}

// LoadRoutes reads, parses and validates the routes file at path.
func LoadRoutes(path string) (*Routes, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("routes file: %w", err)
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxRoutesFileBytes+1))
	if err != nil {
		return nil, fmt.Errorf("routes file %s: %w", path, err)
	}
	if len(data) > maxRoutesFileBytes {
		return nil, fmt.Errorf("routes file %s: larger than %d bytes", path, maxRoutesFileBytes)
	}
	routes, err := ParseRoutes(data)
	if err != nil {
		return nil, fmt.Errorf("routes file %s: %w", path, err)
	}
	return routes, nil
}

// ParseRoutes parses and validates a routes file. It fills in defaults and normalises names
// (upper-case methods, lower-case hosts, canonical header names), and reports every problem it
// finds, each naming its route and field.
func ParseRoutes(data []byte) (*Routes, error) {
	var file struct {
		Routes []json.RawMessage `json:"routes"`
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&file); err != nil {
		return nil, fmt.Errorf("invalid JSON: %w", err)
	}
	if dec.More() {
		return nil, errors.New("invalid JSON: data after the top-level object")
	}
	if file.Routes == nil {
		return nil, errors.New(`missing "routes"`)
	}

	var errs []error
	routes := &Routes{Routes: make([]Route, 0, len(file.Routes))}
	for i, raw := range file.Routes {
		var r Route
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if err := d.Decode(&r); err != nil {
			errs = append(errs, &RouteError{Route: routeName(i, peekID(raw)), Message: "invalid JSON: " + err.Error()})
			continue
		}
		routes.Routes = append(routes.Routes, r)
	}
	if len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	for i := range routes.Routes {
		routes.Routes[i].normalize()
	}
	if err := routes.validate(); err != nil {
		return nil, err
	}
	return routes, nil
}

// peekID extracts the id of a route that failed to decode, so that the error can name it.
func peekID(raw json.RawMessage) string {
	var v struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(raw, &v)
	return v.ID
}

func routeName(i int, id string) string {
	if id != "" && validRouteID(id) {
		return fmt.Sprintf("route %q", id)
	}
	return fmt.Sprintf("routes[%d]", i)
}

// normalize fills in defaults and puts names in canonical form. Values that are invalid stay
// as they are for validate to report.
func (r *Route) normalize() {
	r.Host = strings.ToLower(strings.TrimSuffix(r.Host, "."))
	for i, m := range r.Methods {
		r.Methods[i] = strings.ToUpper(m)
	}
	if r.Auth == "" {
		r.Auth = AuthNone
	}
	if r.Timeout == 0 {
		r.Timeout = Duration(DefaultTimeout)
	}
	for i := range r.Upstreams {
		if r.Upstreams[i].Weight == 0 {
			r.Upstreams[i].Weight = 1
		}
	}
	if rt := r.Retry; rt != nil {
		if rt.Attempts == 0 {
			rt.Attempts = DefaultRetryAttempts
		}
		if rt.OnStatus == nil {
			rt.OnStatus = append([]int(nil), DefaultRetryStatuses...)
		}
		if rt.OnErrors == nil {
			rt.OnErrors = append([]string(nil), DefaultRetryErrors...)
		}
		if rt.Backoff == 0 {
			rt.Backoff = Duration(DefaultRetryBackoff)
		}
		if rt.MaxBackoff == 0 {
			rt.MaxBackoff = Duration(max(DefaultRetryMaxBackoff, rt.Backoff.D()))
		}
	}
	if cb := r.CircuitBreaker; cb != nil {
		if cb.FailureRatio == 0 {
			cb.FailureRatio = DefaultBreakerFailureRatio
		}
		if cb.Window == 0 {
			cb.Window = DefaultBreakerWindow
		}
		if cb.MinRequests == 0 {
			cb.MinRequests = min(DefaultBreakerMinRequests, cb.Window)
		}
		if cb.OpenDuration == 0 {
			cb.OpenDuration = Duration(DefaultBreakerOpenDuration)
		}
		if cb.HalfOpenProbes == 0 {
			cb.HalfOpenProbes = DefaultBreakerProbes
		}
	}
	if hc := r.HealthCheck; hc != nil {
		if hc.Path == "" {
			hc.Path = DefaultHealthPath
		}
		if hc.Interval == 0 {
			hc.Interval = Duration(DefaultHealthInterval)
		}
		if hc.Timeout == 0 {
			hc.Timeout = Duration(min(DefaultHealthTimeout, hc.Interval.D()))
		}
		if hc.HealthyThreshold == 0 {
			hc.HealthyThreshold = DefaultHealthyThreshold
		}
		if hc.UnhealthyThreshold == 0 {
			hc.UnhealthyThreshold = DefaultUnhealthyThreshold
		}
	}
	if t := r.Transforms; t != nil {
		t.Request.normalize()
		t.Response.normalize()
	}
}

// AllowsMethod reports whether the route accepts method.
func (r *Route) AllowsMethod(method string) bool {
	if len(r.Methods) == 0 {
		return true
	}
	for _, m := range r.Methods {
		if m == method {
			return true
		}
	}
	return false
}

// MatchPath returns the path or prefix the route matches on, and whether it is a prefix.
func (r *Route) MatchPath() (path string, prefix bool) {
	if r.Path != "" {
		return r.Path, false
	}
	return r.PathPrefix, true
}
