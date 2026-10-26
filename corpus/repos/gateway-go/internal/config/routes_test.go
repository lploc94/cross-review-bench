package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fullRoute = `{
  "routes": [
    {
      "id": "orders",
      "host": "API.Example.com.",
      "path_prefix": "/orders",
      "methods": ["get", "POST"],
      "upstreams": [{"url": "http://10.0.0.1:8080/v2", "weight": 3}, {"url": "http://10.0.0.2:8080"}],
      "strip_prefix": true,
      "timeout": "5s",
      "auth": "api_key",
      "rate_limit": {"requests": 100, "window": "1m"},
      "retry": {"attempts": 3},
      "circuit_breaker": {"failure_ratio": 0.25, "window": 40},
      "health_check": {"path": "/healthz"},
      "transforms": {
        "request": {"add": {"x-gateway": "1"}, "remove": ["x-debug"], "rename": {"x-old": "x-new"}},
        "response": {"remove": ["server"]}
      }
    }
  ]
}`

func TestParseRoutesFillsDefaultsAndNormalizes(t *testing.T) {
	rs, err := ParseRoutes([]byte(fullRoute))
	if err != nil {
		t.Fatal(err)
	}
	r := rs.Routes[0]
	if r.Host != "api.example.com" || r.Methods[0] != "GET" || r.Timeout.D() != 5*time.Second {
		t.Errorf("normalized = host %q methods %v timeout %s", r.Host, r.Methods, r.Timeout.D())
	}
	if r.Upstreams[1].Weight != 1 {
		t.Errorf("default weight = %d", r.Upstreams[1].Weight)
	}
	rt := r.Retry
	if len(rt.OnStatus) != 3 || len(rt.OnErrors) != 3 || rt.Backoff.D() != DefaultRetryBackoff || rt.MaxBackoff.D() != DefaultRetryMaxBackoff {
		t.Errorf("retry defaults = %+v", rt)
	}
	cb := r.CircuitBreaker
	if cb.FailureRatio != 0.25 || cb.Window != 40 || cb.MinRequests != DefaultBreakerMinRequests || cb.HalfOpenProbes != 1 || cb.OpenDuration.D() != 30*time.Second {
		t.Errorf("breaker defaults = %+v", cb)
	}
	hc := r.HealthCheck
	if hc.Interval.D() != 10*time.Second || hc.Timeout.D() != 2*time.Second || hc.HealthyThreshold != 2 || hc.UnhealthyThreshold != 3 {
		t.Errorf("health defaults = %+v", hc)
	}
	req := r.Transforms.Request
	if req.Add["X-Gateway"] != "1" || req.Remove[0] != "X-Debug" || req.Rename["X-Old"] != "X-New" {
		t.Errorf("transform names not canonical: %+v", req)
	}
}

func TestParseRoutesDefaultsWithoutOptionalBlocks(t *testing.T) {
	rs, err := ParseRoutes([]byte(`{"routes":[{"id":"a","path_prefix":"/","upstreams":[{"url":"https://a.internal"}]}]}`))
	if err != nil {
		t.Fatal(err)
	}
	r := rs.Routes[0]
	if r.Auth != AuthNone || r.Timeout.D() != DefaultTimeout || r.Retry != nil || r.RateLimit != nil || r.CircuitBreaker != nil {
		t.Errorf("route = %+v", r)
	}
}

func TestEmptyRetryListsMeanNone(t *testing.T) {
	rs, err := ParseRoutes([]byte(`{"routes":[{"id":"a","path":"/x","upstreams":[{"url":"http://a"}],
		"retry":{"attempts":2,"on_status":[],"on_errors":["connect"]}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if rt := rs.Routes[0].Retry; len(rt.OnStatus) != 0 || len(rt.OnErrors) != 1 {
		t.Errorf("retry = %+v; an explicit empty list must not get the defaults", rt)
	}
}

// problems parses data and returns each problem's text.
func problems(t *testing.T, data string) []string {
	t.Helper()
	_, err := ParseRoutes([]byte(data))
	if err == nil {
		t.Fatal("ParseRoutes accepted an invalid file")
	}
	return strings.Split(err.Error(), "\n")
}

func TestValidationNamesRouteAndField(t *testing.T) {
	cases := []struct {
		name, route, want string
	}{
		{"missing id", `{"path":"/a","upstreams":[{"url":"http://a"}]}`, `routes[0]: id: is required`},
		{"bad id", `{"id":"Bad ID","path":"/a","upstreams":[{"url":"http://a"}]}`, `routes[0]: id: must be 1 to 64`},
		{"no path", `{"id":"a","upstreams":[{"url":"http://a"}]}`, `route "a": path_prefix: one of path and path_prefix is required`},
		{"both paths", `{"id":"a","path":"/a","path_prefix":"/a","upstreams":[{"url":"http://a"}]}`, `route "a": path: path and path_prefix are mutually exclusive`},
		{"unclean path", `{"id":"a","path_prefix":"/a/../b","upstreams":[{"url":"http://a"}]}`, `route "a": path_prefix: must be a clean path`},
		{"relative path", `{"id":"a","path":"a","upstreams":[{"url":"http://a"}]}`, `route "a": path: must start with '/'`},
		{"strip on exact", `{"id":"a","path":"/a","strip_prefix":true,"upstreams":[{"url":"http://a"}]}`, `route "a": strip_prefix: needs path_prefix`},
		{"bad host", `{"id":"a","host":"a.example.com:8080","path":"/a","upstreams":[{"url":"http://a"}]}`, `route "a": host: must be a host name without port`},
		{"bad method", `{"id":"a","path":"/a","methods":["GET","FETCH"],"upstreams":[{"url":"http://a"}]}`, `route "a": methods[1]: must be one of`},
		{"no upstreams", `{"id":"a","path":"/a","upstreams":[]}`, `route "a": upstreams: at least one upstream is required`},
		{"relative upstream", `{"id":"a","path":"/a","upstreams":[{"url":"/svc"}]}`, `route "a": upstreams[0].url: must be an absolute http or https URL`},
		{"upstream query", `{"id":"a","path":"/a","upstreams":[{"url":"http://a/?x=1"}]}`, `route "a": upstreams[0].url: must not have a query or fragment`},
		{"upstream creds", `{"id":"a","path":"/a","upstreams":[{"url":"http://u:p@a"}]}`, `route "a": upstreams[0].url: must not contain credentials`},
		{"duplicate upstream", `{"id":"a","path":"/a","upstreams":[{"url":"http://a/"},{"url":"http://a"}]}`, `route "a": upstreams[1].url: duplicates upstreams[0]`},
		{"weight", `{"id":"a","path":"/a","upstreams":[{"url":"http://a","weight":101}]}`, `route "a": upstreams[0].weight: must be between 1 and 100`},
		{"auth", `{"id":"a","path":"/a","auth":"basic","upstreams":[{"url":"http://a"}]}`, `route "a": auth: must be "none", "api_key" or "hmac"`},
		{"rate window", `{"id":"a","path":"/a","rate_limit":{"requests":1,"window":"500ms"},"upstreams":[{"url":"http://a"}]}`, `route "a": rate_limit.window: must be a whole number of milliseconds`},
		{"rate requests", `{"id":"a","path":"/a","rate_limit":{"requests":0,"window":"1s"},"upstreams":[{"url":"http://a"}]}`, `route "a": rate_limit.requests: must be at least 1`},
		{"retry attempts", `{"id":"a","path":"/a","retry":{"attempts":11},"upstreams":[{"url":"http://a"}]}`, `route "a": retry.attempts: must be between 1 and 10`},
		{"retry status", `{"id":"a","path":"/a","retry":{"attempts":2,"on_status":[404]},"upstreams":[{"url":"http://a"}]}`, `route "a": retry.on_status[0]: must be a 5xx status`},
		{"retry error", `{"id":"a","path":"/a","retry":{"attempts":2,"on_errors":["dns"]},"upstreams":[{"url":"http://a"}]}`, `route "a": retry.on_errors[0]: must be`},
		{"backoff order", `{"id":"a","path":"/a","retry":{"attempts":2,"backoff":"2s","max_backoff":"1s"},"upstreams":[{"url":"http://a"}]}`, `route "a": retry.max_backoff: must not be shorter than retry.backoff`},
		{"breaker ratio", `{"id":"a","path":"/a","circuit_breaker":{"failure_ratio":1.5},"upstreams":[{"url":"http://a"}]}`, `route "a": circuit_breaker.failure_ratio: must be greater than 0`},
		{"breaker min", `{"id":"a","path":"/a","circuit_breaker":{"window":5,"min_requests":6},"upstreams":[{"url":"http://a"}]}`, `route "a": circuit_breaker.min_requests: must be between 1 and circuit_breaker.window`},
		{"health interval", `{"id":"a","path":"/a","health_check":{"path":"/h","interval":"100ms"},"upstreams":[{"url":"http://a"}]}`, `route "a": health_check.interval: must be at least 1s`},
		{"health timeout", `{"id":"a","path":"/a","health_check":{"path":"/h","interval":"2s","timeout":"3s"},"upstreams":[{"url":"http://a"}]}`, `route "a": health_check.timeout: must be positive and at most health_check.interval`},
		{"health path", `{"id":"a","path":"/a","health_check":{"path":"h"},"upstreams":[{"url":"http://a"}]}`, `route "a": health_check.path: must start with '/'`},
		{"bad duration", `{"id":"a","path":"/a","timeout":"soon","upstreams":[{"url":"http://a"}]}`, `route "a": invalid JSON: must be a duration string`},
		{"unknown field", `{"id":"a","path":"/a","retries":{},"upstreams":[{"url":"http://a"}]}`, `route "a": invalid JSON: json: unknown field "retries"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := problems(t, `{"routes":[`+c.route+`]}`)
			for _, p := range got {
				if strings.HasPrefix(p, c.want) {
					return
				}
			}
			t.Errorf("problems %q do not include %q", got, c.want)
		})
	}
}

func TestTransformValidation(t *testing.T) {
	cases := map[string]string{
		`{"add":{"X-Forwarded-For":"1.2.3.4"}}`: `transforms.request.add.X-Forwarded-For: X-Forwarded-For is managed by the gateway`,
		`{"remove":["Connection"]}`:             `transforms.request.remove[0]: Connection is managed by the gateway`,
		`{"remove":["Proxy-Authorization"]}`:    `transforms.request.remove[0]: Proxy-Authorization is managed by the gateway`,
		`{"rename":{"X-A":"X-Consumer-Id"}}`:    `transforms.request.rename.X-A: X-Consumer-Id is managed by the gateway`,
		`{"rename":{"X-A":"x-a"}}`:              `transforms.request.rename.X-A: renames the header to itself`,
		`{"add":{"Bad Name":"v"}}`:              `transforms.request.add.Bad Name: "Bad Name" is not a valid header name`,
		`{"add":{"X-A":"line\nbreak"}}`:         `transforms.request.add.X-A: has an invalid value`,
		`{"add":{"x-a":"1","X-A":"2"}}`:         `transforms.request.add.X-A: is given twice in different spellings`,
		`{"rename":{"X-A":"X-C","X-B":"X-C"}}`:  `transforms.request.rename.X-B: renames to X-C like rename.X-A`,
		`{"add":{"Host":"evil.example"}}`:       `transforms.request.add.Host: Host is managed by the gateway`,
		`{"remove":["content-length"]}`:         `transforms.request.remove[0]: Content-Length is managed by the gateway`,
	}
	for transform, want := range cases {
		got := problems(t, `{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://a"}],"transforms":{"request":`+transform+`}}]}`)
		if !strings.Contains(strings.Join(got, "\n"), `route "a": `+want) {
			t.Errorf("%s: problems %q do not include %q", transform, got, want)
		}
	}
}

func TestTiesAreErrors(t *testing.T) {
	cases := []struct {
		name  string
		a, b  string
		tie   bool
		field string
	}{
		{"same prefix all methods", `"path_prefix":"/api"`, `"path_prefix":"/api"`, true, "path_prefix"},
		{"same exact path, overlapping methods", `"path":"/x","methods":["GET","POST"]`, `"path":"/x","methods":["POST"]`, true, "path"},
		{"same exact path, disjoint methods", `"path":"/x","methods":["GET"]`, `"path":"/x","methods":["POST"]`, false, ""},
		{"prefix and exact on the same path", `"path_prefix":"/x"`, `"path":"/x"`, false, ""},
		{"trailing slash is a different prefix", `"path_prefix":"/x"`, `"path_prefix":"/x/"`, false, ""},
		{"different hosts", `"path_prefix":"/x","host":"a.example"`, `"path_prefix":"/x","host":"b.example"`, false, ""},
		{"same host in different case", `"path_prefix":"/x","host":"A.example"`, `"path_prefix":"/x","host":"a.example"`, true, "path_prefix"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			data := `{"routes":[{"id":"first",` + c.a + `,"upstreams":[{"url":"http://a"}]},{"id":"second",` + c.b + `,"upstreams":[{"url":"http://b"}]}]}`
			_, err := ParseRoutes([]byte(data))
			if !c.tie {
				if err != nil {
					t.Fatalf("not a tie, but: %v", err)
				}
				return
			}
			var re *RouteError
			if !errors.As(err, &re) || re.Route != `route "second"` || re.Field != c.field || !strings.Contains(re.Message, `route "first"`) {
				t.Errorf("err = %v, want a tie of second with first on %s", err, c.field)
			}
		})
	}
}

func TestDuplicateIDs(t *testing.T) {
	got := problems(t, `{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://a"}]},{"id":"a","path":"/b","upstreams":[{"url":"http://a"}]}]}`)
	if !strings.Contains(strings.Join(got, "\n"), `route "a": id: duplicates routes[0]`) {
		t.Errorf("problems = %q", got)
	}
}

func TestParseRoutesRejectsMalformedFiles(t *testing.T) {
	for _, data := range []string{``, `[]`, `{}`, `{"routes":[]} {}`, `{"routes":[],"extra":1}`} {
		if _, err := ParseRoutes([]byte(data)); err == nil {
			t.Errorf("ParseRoutes(%q) succeeded", data)
		}
	}
	if rs, err := ParseRoutes([]byte(`{"routes":[]}`)); err != nil || len(rs.Routes) != 0 {
		t.Errorf("an empty route list: %v, %v", rs, err)
	}
}

func TestLoadRoutes(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "routes.json")
	if err := os.WriteFile(good, []byte(fullRoute), 0o600); err != nil {
		t.Fatal(err)
	}
	rs, err := LoadRoutes(good)
	if err != nil || len(rs.Routes) != 1 {
		t.Fatalf("LoadRoutes = %v, %v", rs, err)
	}

	bad := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(bad, []byte(`{"routes":[{"id":"x","path":"/x","upstreams":[]}]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadRoutes(bad); err == nil || !strings.Contains(err.Error(), bad) || !strings.Contains(err.Error(), `route "x": upstreams`) {
		t.Errorf("err = %v, want the file, route and field named", err)
	}
	if _, err := LoadRoutes(filepath.Join(dir, "missing.json")); err == nil {
		t.Error("LoadRoutes of a missing file succeeded")
	}
}

func TestIsCleanPath(t *testing.T) {
	for p, want := range map[string]bool{
		"/": true, "/a": true, "/a/": true, "/a/b": true,
		"": false, "a": false, "//a": false, "/a//b": false, "/a/./b": false, "/a/../b": false, "/..": false, "/a/.": false,
	} {
		if got := IsCleanPath(p); got != want {
			t.Errorf("IsCleanPath(%q) = %v, want %v", p, got, want)
		}
	}
}

// TestEmptyPolicyObjectsGetDocumentedDefaults checks the README's promise: an empty retry,
// circuit_breaker or health_check object is valid and takes the documented defaults.
func TestEmptyPolicyObjectsGetDocumentedDefaults(t *testing.T) {
	routes, err := ParseRoutes([]byte(`{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://a"}],
	  "retry":{},"circuit_breaker":{},"health_check":{}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	r := routes.Routes[0]
	rt := r.Retry
	if rt.Attempts != 3 || len(rt.OnStatus) != 3 || len(rt.OnErrors) != 3 || rt.Backoff.D() != 50*time.Millisecond ||
		rt.MaxBackoff.D() != time.Second || rt.NonIdempotent {
		t.Errorf("retry = %+v", *rt)
	}
	cb := r.CircuitBreaker
	if cb.FailureRatio != 0.5 || cb.MinRequests != 10 || cb.Window != 20 || cb.OpenDuration.D() != 30*time.Second || cb.HalfOpenProbes != 1 {
		t.Errorf("circuit_breaker = %+v", *cb)
	}
	hc := r.HealthCheck
	if hc.Path != "/healthz" || hc.Interval.D() != 10*time.Second || hc.Timeout.D() != 2*time.Second ||
		hc.HealthyThreshold != 2 || hc.UnhealthyThreshold != 3 {
		t.Errorf("health_check = %+v", *hc)
	}
	if r.Auth != AuthNone || r.Timeout.D() != 30*time.Second || r.Upstreams[0].Weight != 1 {
		t.Errorf("route = %+v", r)
	}
}
