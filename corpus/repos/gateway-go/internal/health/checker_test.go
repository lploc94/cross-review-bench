package health

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/logging"
)

var t0 = time.Date(2025, time.June, 2, 12, 0, 0, 0, time.UTC)

// fixture is a checker against a test server whose answer the test controls.
type fixture struct {
	clk     *clock.Manual
	status  atomic.Int32
	mu      sync.Mutex
	reports []bool
	paths   chan string
	stop    func()
}

func newFixture(t *testing.T, healthy, unhealthy int) *fixture {
	t.Helper()
	f := &fixture{clk: clock.NewManual(t0), paths: make(chan string, 32)}
	f.status.Store(http.StatusOK)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.paths <- r.URL.Path
		w.WriteHeader(int(f.status.Load()))
	}))
	t.Cleanup(srv.Close)
	target, _ := url.Parse(srv.URL + "/base/")
	c := &Checker{
		Target:             target,
		Path:               "/healthz",
		Interval:           10 * time.Second,
		Timeout:            5 * time.Second,
		HealthyThreshold:   healthy,
		UnhealthyThreshold: unhealthy,
		Client:             &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		Clock:              f.clk,
		Logger:             logging.Discard(),
		Report: func(h bool) {
			f.mu.Lock()
			f.reports = append(f.reports, h)
			f.mu.Unlock()
		},
	}
	stop, err := c.Start()
	if err != nil {
		t.Fatal(err)
	}
	f.stop = stop
	t.Cleanup(stop)
	return f
}

// settle waits for the probe in progress to be recorded: the checker registers its interval
// wait on the clock only after recording a result.
func (f *fixture) settle() {
	<-f.paths
	f.clk.BlockUntil(1)
}

// next answers the next probe with status and waits for it to be recorded.
func (f *fixture) next(status int) {
	f.status.Store(int32(status))
	f.clk.Advance(10 * time.Second)
	f.settle()
}

func (f *fixture) got() []bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]bool(nil), f.reports...)
}

func TestCheckerThresholds(t *testing.T) {
	f := newFixture(t, 2, 3)
	f.settle() // first probe at start: 200
	f.next(http.StatusInternalServerError)
	f.next(http.StatusBadGateway)
	if len(f.got()) != 0 {
		t.Fatalf("reported after two failures with a threshold of three: %v", f.got())
	}
	f.next(http.StatusServiceUnavailable)
	if got := f.got(); len(got) != 1 || got[0] {
		t.Fatalf("reports = %v, want one unhealthy report", got)
	}
	f.next(http.StatusServiceUnavailable) // still unhealthy: no repeated report
	f.next(http.StatusOK)
	if len(f.got()) != 1 {
		t.Fatalf("reported healthy after one success with a threshold of two")
	}
	f.next(http.StatusFound) // a redirect is an answer, and a success
	if got := f.got(); len(got) != 2 || !got[1] {
		t.Fatalf("reports = %v, want healthy again", got)
	}
}

func TestCheckerFailureStreakResetsOnSuccess(t *testing.T) {
	f := newFixture(t, 1, 2)
	f.settle()
	f.next(http.StatusInternalServerError)
	f.next(http.StatusOK)
	f.next(http.StatusInternalServerError)
	if len(f.got()) != 0 {
		t.Fatalf("failures that were not consecutive made the upstream unhealthy: %v", f.got())
	}
}

func TestCheckerRequestsPathUnderBase(t *testing.T) {
	f := newFixture(t, 1, 1)
	if p := <-f.paths; p != "/base/healthz" {
		t.Errorf("probed %q, want /base/healthz", p)
	}
	f.clk.BlockUntil(1)
}

func TestCheckerUnreachableUpstreamIsUnhealthy(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	target, _ := url.Parse(srv.URL)
	srv.Close() // nothing listens there any more
	clk := clock.NewManual(t0)
	reports := make(chan bool, 1)
	c := &Checker{Target: target, Path: "/h", Interval: time.Second, Timeout: time.Second,
		HealthyThreshold: 1, UnhealthyThreshold: 1, Client: &http.Client{}, Clock: clk,
		Logger: logging.Discard(), Report: func(h bool) { reports <- h }}
	stop, err := c.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	if healthy := <-reports; healthy {
		t.Error("an unreachable upstream was reported healthy")
	}
}

func TestCheckerTimeout(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)
	target, _ := url.Parse(srv.URL)
	reports := make(chan bool, 1)
	c := &Checker{Target: target, Path: "/h", Interval: time.Second, Timeout: 20 * time.Millisecond,
		HealthyThreshold: 1, UnhealthyThreshold: 1, Client: &http.Client{}, Clock: clock.NewManual(t0),
		Logger: logging.Discard(), Report: func(h bool) { reports <- h }}
	stop, err := c.Start()
	if err != nil {
		t.Fatal(err)
	}
	defer stop()
	if healthy := <-reports; healthy {
		t.Error("an upstream that never answers was reported healthy")
	}
}

func TestCheckerStopIsIdempotentAndEndsProbing(t *testing.T) {
	f := newFixture(t, 1, 1)
	f.settle()
	f.stop()
	f.stop()
	f.clk.Advance(time.Hour)
	select {
	case p := <-f.paths:
		t.Errorf("probe of %s after stop", p)
	default:
	}
}

func TestCheckerStartValidates(t *testing.T) {
	if _, err := (&Checker{}).Start(); err == nil {
		t.Error("Start of an empty checker succeeded")
	}
	target, _ := url.Parse("http://u")
	c := &Checker{Target: target, Client: &http.Client{}, Clock: clock.NewManual(t0), Logger: logging.Discard(),
		Report: func(bool) {}, Interval: time.Second, Timeout: time.Second}
	if _, err := c.Start(); err == nil {
		t.Error("Start with zero thresholds succeeded")
	}
}

func TestCheckerURLKeepsTheBaseEscaping(t *testing.T) {
	for base, want := range map[string]string{
		"http://u":        "http://u/healthz",
		"http://u/base/":  "http://u/base/healthz",
		"http://u/b%2Fc":  "http://u/b%2Fc/healthz",
		"http://u/b%20c/": "http://u/b%20c/healthz",
	} {
		target, err := url.Parse(base)
		if err != nil {
			t.Fatal(err)
		}
		c := &Checker{Target: target, Path: "/healthz"}
		if got := c.URL(); got != want {
			t.Errorf("base %s: URL() = %s, want %s", base, got, want)
		}
	}
}
