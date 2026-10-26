package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

func render(t *testing.T, r *Registry) string {
	t.Helper()
	var b strings.Builder
	if err := r.WriteText(&b); err != nil {
		t.Fatal(err)
	}
	return b.String()
}

func TestCounterAndGaugeExposition(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("jobs_total", "Jobs processed.", "queue", "outcome")
	g := r.NewGauge("busy", "Busy workers.")
	c.Inc("emails", "ok")
	c.Add(2.5, "emails", "ok")
	c.Inc("billing", "error")
	g.Set(3)
	g.Add(-1)

	want := `# HELP jobs_total Jobs processed.
# TYPE jobs_total counter
jobs_total{queue="billing",outcome="error"} 1
jobs_total{queue="emails",outcome="ok"} 3.5
# HELP busy Busy workers.
# TYPE busy gauge
busy 2
`
	if got := render(t, r); got != want {
		t.Errorf("exposition:\n%s\nwant:\n%s", got, want)
	}
	if c.Value("emails", "ok") != 3.5 || c.Value("missing", "x") != 0 || g.Value() != 2 {
		t.Error("Value does not match what was recorded")
	}
}

func TestHistogramBucketsAreCumulative(t *testing.T) {
	r := NewRegistry()
	h := r.NewHistogram("latency_seconds", "Latency.", []float64{0.1, 1}, "route")
	for _, v := range []float64{0.05, 0.1, 0.5, 3} {
		h.Observe(v, "/x")
	}
	want := `# HELP latency_seconds Latency.
# TYPE latency_seconds histogram
latency_seconds_bucket{route="/x",le="0.1"} 2
latency_seconds_bucket{route="/x",le="1"} 3
latency_seconds_bucket{route="/x",le="+Inf"} 4
latency_seconds_sum{route="/x"} 3.65
latency_seconds_count{route="/x"} 4
`
	if got := render(t, r); got != want {
		t.Errorf("exposition:\n%s\nwant:\n%s", got, want)
	}
	if h.Count("/x") != 4 {
		t.Errorf("Count = %d", h.Count("/x"))
	}
}

func TestEscaping(t *testing.T) {
	r := NewRegistry()
	r.NewCounter("c", "Line one\nback\\slash", "v").Inc("say \"hi\"\n\\")
	got := render(t, r)
	if !strings.Contains(got, `# HELP c Line one\nback\\slash`) {
		t.Errorf("help not escaped:\n%s", got)
	}
	if !strings.Contains(got, `c{v="say \"hi\"\n\\"} 1`) {
		t.Errorf("label value not escaped:\n%s", got)
	}
}

func TestGaugeFunc(t *testing.T) {
	r := NewRegistry()
	n := 0.0
	r.NewGaugeFunc("connections", "Open connections.", func() float64 { n++; return n })
	if got := render(t, r); !strings.HasSuffix(got, "connections 1\n") {
		t.Errorf("first scrape:\n%s", got)
	}
	if got := render(t, r); !strings.HasSuffix(got, "connections 2\n") {
		t.Errorf("second scrape reads the function again:\n%s", got)
	}
}

func TestRegistrationPanics(t *testing.T) {
	cases := map[string]func(r *Registry){
		"bad metric name":    func(r *Registry) { r.NewCounter("1abc", "") },
		"bad label name":     func(r *Registry) { r.NewCounter("c", "", "bad-label") },
		"reserved label":     func(r *Registry) { r.NewCounter("c", "", "__name") },
		"le on a histogram":  func(r *Registry) { r.NewHistogram("h", "", nil, "le") },
		"unsorted buckets":   func(r *Registry) { r.NewHistogram("h", "", []float64{1, 0.5}) },
		"duplicate name":     func(r *Registry) { r.NewGauge("g", ""); r.NewCounter("g", "") },
		"wrong label count":  func(r *Registry) { r.NewCounter("c", "", "a").Inc() },
		"negative increment": func(r *Registry) { r.NewCounter("c", "").Add(-1) },
	}
	for name, fn := range cases {
		t.Run(name, func(t *testing.T) {
			defer func() {
				if recover() == nil {
					t.Error("did not panic")
				}
			}()
			fn(NewRegistry())
		})
	}
}

func TestConcurrentUpdates(t *testing.T) {
	r := NewRegistry()
	c := r.NewCounter("c", "", "k")
	h := r.NewHistogram("h", "", nil)
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 1000 {
				c.Inc([]string{"a", "b"}[i%2])
				h.Observe(0.2)
			}
		}()
	}
	wg.Wait()
	if c.Value("a")+c.Value("b") != 8000 || h.Count() != 8000 {
		t.Errorf("lost updates: counter %v, histogram %d", c.Value("a")+c.Value("b"), h.Count())
	}
}

func TestHandler(t *testing.T) {
	r := NewRegistry()
	r.NewCounter("up", "Up.").Inc()
	rec := httptest.NewRecorder()
	r.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != ContentType || !strings.Contains(rec.Body.String(), "up 1\n") {
		t.Errorf("response %d %q:\n%s", rec.Code, rec.Header().Get("Content-Type"), rec.Body.String())
	}
}
