package config

import (
	"errors"
	"fmt"
	"net/textproto"
	"net/url"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/relaywork/gateway/internal/header"
)

// Limits on route settings.
const (
	MaxUpstreams       = 64
	MaxUpstreamWeight  = 100
	MaxRetryAttempts   = 10
	MaxBreakerWindow   = 1000
	MaxBreakerProbes   = 100
	MinRateLimitWindow = time.Second
	MaxRateLimitWindow = 24 * time.Hour
	MinHealthInterval  = time.Second
	MaxTimeout         = 10 * time.Minute
)

var (
	routeIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	hostPattern    = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)
)

// knownMethods are the methods a route may list. CONNECT and TRACE are not proxied.
var knownMethods = []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}

func validRouteID(id string) bool { return routeIDPattern.MatchString(id) }

// routeProblems collects the problems of one route.
type routeProblems struct {
	route string
	errs  *[]error
}

func (p routeProblems) add(field, format string, args ...any) {
	*p.errs = append(*p.errs, &RouteError{Route: p.route, Field: field, Message: fmt.Sprintf(format, args...)})
}

func (rs *Routes) validate() error {
	var errs []error
	seen := make(map[string]int)
	for i := range rs.Routes {
		r := &rs.Routes[i]
		p := routeProblems{route: routeName(i, r.ID), errs: &errs}
		if !validRouteID(r.ID) {
			if r.ID == "" {
				p.add("id", "is required")
			} else {
				p.add("id", "must be 1 to 64 lower-case letters, digits, '.', '-' or '_', starting with a letter or digit")
			}
		} else if j, dup := seen[r.ID]; dup {
			p.add("id", "duplicates routes[%d]", j)
		} else {
			seen[r.ID] = i
		}
		r.validate(p)
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	// Ties are only meaningful between routes that are valid on their own.
	if err := rs.checkTies(); err != nil {
		return err
	}
	return nil
}

func (r *Route) validate(p routeProblems) {
	if r.Host != "" && !hostPattern.MatchString(r.Host) {
		p.add("host", "must be a host name without port, got %q", r.Host)
	}
	switch {
	case r.Path == "" && r.PathPrefix == "":
		p.add("path_prefix", "one of path and path_prefix is required")
	case r.Path != "" && r.PathPrefix != "":
		p.add("path", "path and path_prefix are mutually exclusive")
	case r.Path != "":
		if msg := checkMatchPath(r.Path); msg != "" {
			p.add("path", "%s", msg)
		}
		if r.StripPrefix {
			p.add("strip_prefix", "needs path_prefix")
		}
	default:
		if msg := checkMatchPath(r.PathPrefix); msg != "" {
			p.add("path_prefix", "%s", msg)
		}
	}
	seenMethods := make(map[string]bool)
	for i, m := range r.Methods {
		switch {
		case !slices.Contains(knownMethods, m):
			p.add(fmt.Sprintf("methods[%d]", i), "must be one of %s, got %q", strings.Join(knownMethods, ", "), m)
		case seenMethods[m]:
			p.add(fmt.Sprintf("methods[%d]", i), "duplicates %s", m)
		}
		seenMethods[m] = true
	}

	r.validateUpstreams(p)
	if r.Timeout.D() < 0 || r.Timeout.D() > MaxTimeout {
		p.add("timeout", "must be positive and at most %s", MaxTimeout)
	}
	switch r.Auth {
	case AuthNone, AuthAPIKey, AuthHMAC:
	default:
		p.add("auth", "must be %q, %q or %q, got %q", AuthNone, AuthAPIKey, AuthHMAC, r.Auth)
	}
	if rl := r.RateLimit; rl != nil {
		if rl.Requests < 1 {
			p.add("rate_limit.requests", "must be at least 1")
		}
		if w := rl.Window.D(); w < MinRateLimitWindow || w > MaxRateLimitWindow || w%time.Millisecond != 0 {
			p.add("rate_limit.window", "must be a whole number of milliseconds between %s and %s", MinRateLimitWindow, MaxRateLimitWindow)
		}
	}
	if r.Retry != nil {
		r.Retry.validate(p)
	}
	if r.CircuitBreaker != nil {
		r.CircuitBreaker.validate(p)
	}
	if r.HealthCheck != nil {
		r.HealthCheck.validate(p)
	}
	if t := r.Transforms; t != nil {
		t.Request.validate(p, "transforms.request")
		t.Response.validate(p, "transforms.response")
	}
}

// checkMatchPath returns why a configured path cannot be matched, or "".
func checkMatchPath(s string) string {
	if !strings.HasPrefix(s, "/") {
		return fmt.Sprintf("must start with '/', got %q", s)
	}
	if strings.ContainsAny(s, "?#% \t") {
		return fmt.Sprintf("must not contain '?', '#', '%%' or whitespace, got %q", s)
	}
	if !IsCleanPath(s) {
		return fmt.Sprintf("must be a clean path without empty, '.' or '..' segments, got %q", s)
	}
	return ""
}

// IsCleanPath reports whether p is an absolute path with no empty, "." or ".." segments. A
// trailing slash is allowed.
func IsCleanPath(p string) bool {
	if p == "" || p[0] != '/' {
		return false
	}
	clean := path.Clean(p)
	if strings.HasSuffix(p, "/") && clean != "/" {
		clean += "/"
	}
	return clean == p
}

func (r *Route) validateUpstreams(p routeProblems) {
	switch {
	case len(r.Upstreams) == 0:
		p.add("upstreams", "at least one upstream is required")
	case len(r.Upstreams) > MaxUpstreams:
		p.add("upstreams", "at most %d upstreams are allowed", MaxUpstreams)
	}
	seen := make(map[string]int)
	for i, u := range r.Upstreams {
		field := fmt.Sprintf("upstreams[%d]", i)
		parsed, err := url.Parse(u.URL)
		switch {
		case err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https"):
			p.add(field+".url", "must be an absolute http or https URL, got %q", u.URL)
		case parsed.User != nil:
			p.add(field+".url", "must not contain credentials")
		case parsed.RawQuery != "" || parsed.Fragment != "" || parsed.ForceQuery:
			p.add(field+".url", "must not have a query or fragment")
		case parsed.Path != "" && !IsCleanPath(parsed.Path):
			p.add(field+".url", "must have a clean path, got %q", parsed.Path)
		default:
			key := strings.TrimSuffix(parsed.String(), "/")
			if j, dup := seen[key]; dup {
				p.add(field+".url", "duplicates upstreams[%d]", j)
			}
			seen[key] = i
		}
		if u.Weight < 1 || u.Weight > MaxUpstreamWeight {
			p.add(field+".weight", "must be between 1 and %d, got %d", MaxUpstreamWeight, u.Weight)
		}
	}
}

func (rt *Retry) validate(p routeProblems) {
	if rt.Attempts < 1 || rt.Attempts > MaxRetryAttempts {
		p.add("retry.attempts", "must be between 1 and %d, got %d", MaxRetryAttempts, rt.Attempts)
	}
	for i, s := range rt.OnStatus {
		if s < 500 || s > 599 {
			p.add(fmt.Sprintf("retry.on_status[%d]", i), "must be a 5xx status, got %d", s)
		}
	}
	for i, e := range rt.OnErrors {
		switch e {
		case RetryOnConnect, RetryOnTimeout, RetryOnReset:
		default:
			p.add(fmt.Sprintf("retry.on_errors[%d]", i), "must be %q, %q or %q, got %q", RetryOnConnect, RetryOnTimeout, RetryOnReset, e)
		}
	}
	if rt.Backoff.D() < 0 {
		p.add("retry.backoff", "must not be negative")
	}
	if rt.MaxBackoff.D() < rt.Backoff.D() {
		p.add("retry.max_backoff", "must not be shorter than retry.backoff")
	}
	if rt.MaxBackoff.D() > time.Minute {
		p.add("retry.max_backoff", "must be at most 1m")
	}
}

func (cb *CircuitBreaker) validate(p routeProblems) {
	if cb.FailureRatio <= 0 || cb.FailureRatio > 1 {
		p.add("circuit_breaker.failure_ratio", "must be greater than 0 and at most 1, got %v", cb.FailureRatio)
	}
	if cb.Window < 1 || cb.Window > MaxBreakerWindow {
		p.add("circuit_breaker.window", "must be between 1 and %d, got %d", MaxBreakerWindow, cb.Window)
	}
	if cb.MinRequests < 1 || cb.MinRequests > cb.Window {
		p.add("circuit_breaker.min_requests", "must be between 1 and circuit_breaker.window, got %d", cb.MinRequests)
	}
	if cb.OpenDuration.D() <= 0 {
		p.add("circuit_breaker.open_duration", "must be positive")
	}
	if cb.HalfOpenProbes < 1 || cb.HalfOpenProbes > MaxBreakerProbes {
		p.add("circuit_breaker.half_open_probes", "must be between 1 and %d, got %d", MaxBreakerProbes, cb.HalfOpenProbes)
	}
}

func (hc *HealthCheck) validate(p routeProblems) {
	if msg := checkMatchPath(hc.Path); msg != "" {
		p.add("health_check.path", "%s", msg)
	}
	if hc.Interval.D() < MinHealthInterval {
		p.add("health_check.interval", "must be at least %s", MinHealthInterval)
	}
	if hc.Timeout.D() <= 0 || hc.Timeout.D() > hc.Interval.D() {
		p.add("health_check.timeout", "must be positive and at most health_check.interval")
	}
	if hc.HealthyThreshold < 1 || hc.HealthyThreshold > 100 {
		p.add("health_check.healthy_threshold", "must be between 1 and 100, got %d", hc.HealthyThreshold)
	}
	if hc.UnhealthyThreshold < 1 || hc.UnhealthyThreshold > 100 {
		p.add("health_check.unhealthy_threshold", "must be between 1 and 100, got %d", hc.UnhealthyThreshold)
	}
}

// normalize puts the field names in canonical form. Two spellings of one name are kept aside
// for validate to report.
func (t *HeaderTransform) normalize() {
	if t == nil {
		return
	}
	add := make(map[string]string, len(t.Add))
	for k, v := range t.Add {
		c := textproto.CanonicalMIMEHeaderKey(k)
		if _, dup := add[c]; dup {
			t.dupes = append(t.dupes, "add."+c)
		}
		add[c] = v
	}
	t.Add = add
	for i, k := range t.Remove {
		t.Remove[i] = textproto.CanonicalMIMEHeaderKey(k)
	}
	rename := make(map[string]string, len(t.Rename))
	for k, v := range t.Rename {
		c := textproto.CanonicalMIMEHeaderKey(k)
		if _, dup := rename[c]; dup {
			t.dupes = append(t.dupes, "rename."+c)
		}
		rename[c] = textproto.CanonicalMIMEHeaderKey(v)
	}
	t.Rename = rename
}

func (t *HeaderTransform) validate(p routeProblems, field string) {
	if t == nil {
		return
	}
	slices.Sort(t.dupes)
	for _, d := range t.dupes {
		p.add(field+"."+d, "is given twice in different spellings")
	}
	checkName := func(f, name string) {
		switch {
		case !header.ValidName(name):
			p.add(f, "%q is not a valid header name", name)
		case header.IsReserved(name):
			p.add(f, "%s is managed by the gateway and cannot be changed", name)
		}
	}
	for _, name := range sortedKeys(t.Add) {
		checkName(field+".add."+name, name)
		if !header.ValidValue(t.Add[name]) {
			p.add(field+".add."+name, "has an invalid value")
		}
	}
	for i, name := range t.Remove {
		checkName(fmt.Sprintf("%s.remove[%d]", field, i), name)
	}
	targets := make(map[string]string)
	for _, from := range sortedKeys(t.Rename) {
		to := t.Rename[from]
		f := field + ".rename." + from
		checkName(f, from)
		checkName(f, to)
		if from == to {
			p.add(f, "renames the header to itself")
		}
		if other, dup := targets[to]; dup {
			p.add(f, "renames to %s like rename.%s", to, other)
		}
		targets[to] = from
	}
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

// checkTies reports routes that would match the same requests with the same precedence: same
// host, same kind of path match on the same path, and at least one method in common.
func (rs *Routes) checkTies() error {
	type matchKey struct {
		host   string
		path   string
		prefix bool
	}
	byKey := make(map[matchKey][]int)
	var errs []error
	for i := range rs.Routes {
		r := &rs.Routes[i]
		p, prefix := r.MatchPath()
		k := matchKey{host: r.Host, path: p, prefix: prefix}
		for _, j := range byKey[k] {
			other := &rs.Routes[j]
			if common := commonMethods(r, other); common != "" {
				field := "path"
				if prefix {
					field = "path_prefix"
				}
				errs = append(errs, &RouteError{
					Route:   routeName(i, r.ID),
					Field:   field,
					Message: fmt.Sprintf("matches the same requests as route %q (methods %s); one of them must be more specific", other.ID, common),
				})
			}
		}
		byKey[k] = append(byKey[k], i)
	}
	return errors.Join(errs...)
}

// commonMethods lists the methods both routes accept, or "" when they share none.
func commonMethods(a, b *Route) string {
	switch {
	case len(a.Methods) == 0 && len(b.Methods) == 0:
		return "all"
	case len(a.Methods) == 0:
		return strings.Join(b.Methods, ", ")
	case len(b.Methods) == 0:
		return strings.Join(a.Methods, ", ")
	}
	var common []string
	for _, m := range a.Methods {
		if slices.Contains(b.Methods, m) {
			common = append(common, m)
		}
	}
	return strings.Join(common, ", ")
}
