package core

import (
	"errors"
	"net"
	"slices"
	"sort"
	"strings"
)

// ErrNoRoute reports that no route matches the request's host and path.
var ErrNoRoute = errors.New("no route matches the request")

// MethodNotAllowedError reports that routes match the request's host and path, but none of
// them accepts its method.
type MethodNotAllowedError struct {
	Allow []string // the methods the matching routes accept, sorted
}

func (e *MethodNotAllowedError) Error() string {
	return "method not allowed; allowed: " + strings.Join(e.Allow, ", ")
}

// Table is a compiled route table. It is immutable and safe for concurrent use.
type Table struct {
	routes []*Route
	hosts  map[string]*hostRoutes // "" holds the routes without a host
}

// hostRoutes are the routes of one host, indexed for matching.
type hostRoutes struct {
	exact    map[string][]*Route // by path, in file order
	prefixes []*Route            // longest prefix first, then file order
}

func newTable(routes []*Route) *Table {
	t := &Table{routes: routes, hosts: make(map[string]*hostRoutes)}
	for _, r := range routes {
		hr := t.hosts[r.Host]
		if hr == nil {
			hr = &hostRoutes{exact: make(map[string][]*Route)}
			t.hosts[r.Host] = hr
		}
		if r.Prefix {
			hr.prefixes = append(hr.prefixes, r)
		} else {
			hr.exact[r.Path] = append(hr.exact[r.Path], r)
		}
	}
	for _, hr := range t.hosts {
		sort.SliceStable(hr.prefixes, func(i, j int) bool { return len(hr.prefixes[i].Path) > len(hr.prefixes[j].Path) })
	}
	return t
}

// Routes returns every route in file order.
func (t *Table) Routes() []*Route { return slices.Clone(t.routes) }

// Route returns the route with the given id.
func (t *Table) Route(id string) (*Route, bool) {
	for _, r := range t.routes {
		if r.ID == id {
			return r, true
		}
	}
	return nil, false
}

// Match finds the route for a request. Routes for the request's host are tried before routes
// without a host. Within each, an exact path beats a prefix and a longer prefix beats a shorter
// one; a route that matches the path but not the method is passed over for the next candidate.
// When candidates match the path but none accepts the method, Match returns a
// *MethodNotAllowedError; when none matches the path, ErrNoRoute.
func (t *Table) Match(host, path, method string) (*Route, error) {
	host = normalizeHost(host)
	var allow []string
	matchedPath := false
	groups := []string{host, ""}
	if host == "" {
		groups = groups[:1] // the request names no host: only the host-less routes apply
	}
	for _, h := range groups {
		hr := t.hosts[h]
		if hr == nil {
			continue
		}
		for _, r := range hr.exact[path] {
			if r.AllowsMethod(method) {
				return r, nil
			}
			matchedPath = true
			allow = append(allow, r.Methods...)
		}
		for _, r := range hr.prefixes {
			if !r.matchesPath(path) {
				continue
			}
			if r.AllowsMethod(method) {
				return r, nil
			}
			matchedPath = true
			allow = append(allow, r.Methods...)
		}
	}
	if matchedPath {
		slices.Sort(allow)
		return nil, &MethodNotAllowedError{Allow: slices.Compact(allow)}
	}
	return nil, ErrNoRoute
}

// normalizeHost lower-cases the host of a Host header and removes its port and trailing dot.
func normalizeHost(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.TrimSuffix(host, ".")
	return strings.ToLower(host)
}
