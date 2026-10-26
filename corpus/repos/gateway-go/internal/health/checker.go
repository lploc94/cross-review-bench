// Package health runs active health checks: a goroutine per upstream that requests a configured
// path at a fixed interval and decides, with thresholds of consecutive results, whether the
// upstream is healthy.
package health

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/relaywork/gateway/internal/clock"
)

// maxDrainBytes is how much of a health check response is read so that the connection can be
// reused; larger bodies are dropped with the connection.
const maxDrainBytes = 64 << 10

// Checker checks one upstream.
type Checker struct {
	// Target is the upstream's base URL; Path is appended to its path.
	Target *url.URL
	Path   string

	Interval           time.Duration
	Timeout            time.Duration
	HealthyThreshold   int // consecutive successes that make an unhealthy upstream healthy
	UnhealthyThreshold int // consecutive failures that make a healthy upstream unhealthy

	Client *http.Client
	Clock  clock.Clock
	Logger *slog.Logger

	// Report is called when the upstream's health changes. An upstream starts healthy.
	Report func(healthy bool)
	// Observe, if set, is called after every probe with its result.
	Observe func(ok bool)

	healthy   bool
	successes int
	failures  int
}

// Start validates the checker and starts its goroutine, which probes at once and then every
// Interval. stop ends the goroutine and waits for it; calling it again does nothing.
func (c *Checker) Start() (stop func(), err error) {
	switch {
	case c.Target == nil || c.Client == nil || c.Clock == nil || c.Logger == nil || c.Report == nil:
		return nil, errors.New("health: Target, Client, Clock, Logger and Report are required")
	case c.Interval <= 0 || c.Timeout <= 0:
		return nil, errors.New("health: Interval and Timeout must be positive")
	case c.HealthyThreshold < 1 || c.UnhealthyThreshold < 1:
		return nil, errors.New("health: thresholds must be at least 1")
	}
	c.healthy = true
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		c.run(ctx)
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}, nil
}

func (c *Checker) run(ctx context.Context) {
	for {
		ok := c.probe(ctx)
		if ctx.Err() != nil {
			return // stopped during the probe; its result means nothing
		}
		c.record(ok)
		select {
		case <-ctx.Done():
			return
		case <-c.Clock.After(c.Interval):
		}
	}
}

// record applies one probe result to the thresholds.
func (c *Checker) record(ok bool) {
	if c.Observe != nil {
		c.Observe(ok)
	}
	if ok {
		c.successes++
		c.failures = 0
		if !c.healthy && c.successes >= c.HealthyThreshold {
			c.healthy = true
			c.Logger.Info("upstream is healthy again", "upstream", c.Target.String())
			c.Report(true)
		}
		return
	}
	c.failures++
	c.successes = 0
	if c.healthy && c.failures >= c.UnhealthyThreshold {
		c.healthy = false
		c.Logger.Warn("upstream is unhealthy", "upstream", c.Target.String(), "failures", c.failures)
		c.Report(false)
	}
}

// probe requests the health check path once. A 2xx or 3xx answer within Timeout is a success.
// The timeout is a network deadline on the wall clock; only the interval between probes follows
// the injected clock, so that a test can tell from the clock's waiters that a probe finished.
func (c *Checker) probe(parent context.Context) bool {
	ctx, cancel := context.WithTimeout(parent, c.Timeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.URL(), nil)
	if err != nil {
		c.Logger.Error("health check request", "upstream", c.Target.String(), "error", err)
		return false
	}
	req.Header.Set("User-Agent", "gateway-health-check")
	resp, err := c.Client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = errProbeTimeout
		}
		c.Logger.Debug("health check failed", "upstream", c.Target.String(), "error", err)
		return false
	}
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxDrainBytes))
	resp.Body.Close()
	ok := resp.StatusCode >= 200 && resp.StatusCode < 400
	if !ok {
		c.Logger.Debug("health check failed", "upstream", c.Target.String(), "status", resp.StatusCode)
	}
	return ok
}

var errProbeTimeout = errors.New("health check timed out")

// URL returns the URL the checker requests.
func (c *Checker) URL() string {
	u := *c.Target
	// Join the escaped forms, so that an escaped character in the base path ("/b%2Fc") stays
	// escaped.
	u.RawPath = strings.TrimSuffix(c.Target.EscapedPath(), "/") + (&url.URL{Path: c.Path}).EscapedPath()
	u.Path = strings.TrimSuffix(c.Target.Path, "/") + c.Path
	return u.String()
}
