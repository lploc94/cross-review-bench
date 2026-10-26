// Package core holds the gateway's routing model: the compiled route table and its matcher, the
// policies a route applies (retry, rate limit, circuit breaker, transforms), upstream selection,
// and the runtime that swaps the table on reload while keeping per-upstream state.
package core

import (
	"net/http"
	"net/textproto"
	"net/url"
	"strings"
	"time"

	"github.com/relaywork/gateway/internal/config"
)

// Route is a compiled route. It is immutable once built; a reload builds new routes.
type Route struct {
	ID          string
	Host        string // lower case; "" matches every host
	Path        string // the exact path, or the prefix when Prefix is set
	Prefix      bool
	Methods     []string // nil means every method
	StripPrefix bool
	Timeout     time.Duration // per attempt, until the response headers arrive
	Auth        string        // config.AuthNone, config.AuthAPIKey or config.AuthHMAC
	RateLimit   *RateLimitPolicy
	Retry       RetryPolicy
	Request     HeaderTransform // applied to forwarded requests
	Response    HeaderTransform // applied to responses returned to the client
	Upstreams   []*Upstream

	balancer *Balancer
	spec     config.Route
}

// Spec returns the route as written in the routes file, with defaults filled in.
func (r *Route) Spec() config.Route { return r.spec }

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

// matchesPath reports whether the route's path matcher accepts p. A prefix matches whole path
// segments: "/api" matches "/api" and "/api/orders" but not "/apis"; "/api/" matches only paths
// below "/api/".
func (r *Route) matchesPath(p string) bool {
	if !r.Prefix {
		return p == r.Path
	}
	if !strings.HasPrefix(p, r.Path) {
		return false
	}
	return len(p) == len(r.Path) || strings.HasSuffix(r.Path, "/") || p[len(r.Path)] == '/'
}

// ForwardPath returns the path to request from the upstream, before the upstream's own base
// path is prepended: the request path with the route's prefix removed when StripPrefix is set.
// rawPath is the escaped form when the request had one that survives stripping, and "" when
// the path needs no special escaping.
func (r *Route) ForwardPath(u *url.URL) (path, rawPath string) {
	path, rawPath = u.Path, u.RawPath
	if !r.StripPrefix || !r.Prefix {
		return path, rawPath
	}
	trim := strings.TrimSuffix(r.Path, "/")
	path = path[len(trim):]
	if rawPath != "" {
		rest, ok := strings.CutPrefix(rawPath, trim)
		if ok && (rest == "" || rest[0] == '/') {
			rawPath = rest
		} else {
			// The prefix is escaped differently, or ends inside an escaped segment ("/api%2Fx"
			// under the prefix "/api"); let net/url escape the stripped path instead.
			rawPath = ""
		}
	}
	return path, rawPath
}

// Next picks the upstream for the next attempt, see Balancer.Next.
func (r *Route) Next(skip func(*Upstream) bool) *Upstream { return r.balancer.Next(skip) }

// HeaderTransform is a compiled config.HeaderTransform.
type HeaderTransform struct {
	Rename [][2]string // from, to; in a stable order
	Remove []string
	Add    [][2]string // name, value
}

// Empty reports whether the transform changes nothing.
func (t HeaderTransform) Empty() bool {
	return len(t.Rename) == 0 && len(t.Remove) == 0 && len(t.Add) == 0
}

// Apply renames, then removes, then adds fields of h. A renamed field keeps all its values and
// replaces the target field; an added field replaces any values the field had.
func (t HeaderTransform) Apply(h http.Header) {
	t.Filter(h)
	t.AddTo(h)
}

// AddTo applies the additions of the transform only.
func (t HeaderTransform) AddTo(h http.Header) {
	for _, kv := range t.Add {
		h[kv[0]] = []string{kv[1]}
	}
}

// Filter applies the renames and removals of the transform, not its additions. Trailers go
// through it: the fields a transform adds are set in the header, and trailers of the same name
// are dropped (see Adds).
func (t HeaderTransform) Filter(h http.Header) {
	for _, rn := range t.Rename {
		if values, ok := h[rn[0]]; ok {
			delete(h, rn[0])
			h[rn[1]] = values
		}
	}
	for _, name := range t.Remove {
		delete(h, name)
	}
}

// Adds reports whether the transform adds the field called name, given in canonical form.
func (t HeaderTransform) Adds(name string) bool {
	for _, kv := range t.Add {
		if kv[0] == name {
			return true
		}
	}
	return false
}

func compileTransform(t *config.HeaderTransform) HeaderTransform {
	var out HeaderTransform
	if t == nil {
		return out
	}
	for _, from := range sortedKeys(t.Rename) {
		out.Rename = append(out.Rename, [2]string{from, t.Rename[from]})
	}
	for _, name := range t.Remove {
		out.Remove = append(out.Remove, textproto.CanonicalMIMEHeaderKey(name))
	}
	for _, name := range sortedKeys(t.Add) {
		out.Add = append(out.Add, [2]string{name, t.Add[name]})
	}
	return out
}
