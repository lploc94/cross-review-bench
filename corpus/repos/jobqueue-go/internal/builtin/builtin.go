// Package builtin provides the job handlers every deployment registers: noop, for checking
// that queues and workers are wired up; sleep, for exercising workers and leases under load;
// and http.post, which delivers a JSON body to a URL.
package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/worker"
)

// Job types of the built-in handlers.
const (
	TypeNoop     = "noop"
	TypeSleep    = "sleep"
	TypeHTTPPost = "http.post"
)

// MaxSleep is the longest a sleep job may ask for; it is also the timeout of the sleep type.
const MaxSleep = time.Hour

// maxErrorBody is how much of a failed response body is kept in the job's error.
const maxErrorBody = 512

// Options configures the built-in handlers.
type Options struct {
	HTTPClient    *http.Client // sends http.post requests; nil means a default client
	Clock         clock.Clock  // nil means the wall clock
	LeaseDuration time.Duration
}

// Register installs the built-in handlers in reg.
func Register(reg *worker.Registry, opts Options) {
	if opts.HTTPClient == nil {
		opts.HTTPClient = &http.Client{}
	}
	if opts.Clock == nil {
		opts.Clock = clock.Real{}
	}
	reg.Register(TypeNoop, Noop)
	reg.Register(TypeSleep, Sleep(opts.Clock, opts.LeaseDuration/2), worker.WithTimeout(MaxSleep+time.Minute))
	// http.post keeps the registry's default timeout, which the configuration keeps shorter
	// than the lease; it does not extend its lease.
	reg.Register(TypeHTTPPost, HTTPPost(opts.HTTPClient))
}

// Noop succeeds immediately.
func Noop(context.Context, domain.Job) error { return nil }

// SleepPayload is the payload of a sleep job.
type SleepPayload struct {
	Duration string `json:"duration"` // a Go duration such as "90s"
}

// Sleep returns a handler that waits for the payload's duration and then succeeds. It extends
// its lease every extendEvery, so it may run longer than one lease. A non-positive extendEvery
// means the lease is never extended.
func Sleep(clk clock.Clock, extendEvery time.Duration) worker.HandlerFunc {
	if extendEvery <= 0 {
		extendEvery = MaxSleep
	}
	return func(ctx context.Context, job domain.Job) error {
		var p SleepPayload
		if err := json.Unmarshal(job.Payload, &p); err != nil {
			return domain.Permanent(fmt.Errorf("decode payload: %w", err))
		}
		d, err := time.ParseDuration(p.Duration)
		if err != nil || d < 0 || d > MaxSleep {
			return domain.Permanent(fmt.Errorf("payload duration must be between 0s and %s, got %q", MaxSleep, p.Duration))
		}
		for d > 0 {
			step := min(d, extendEvery)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-clk.After(step):
			}
			d -= step
			if d > 0 {
				if err := worker.ExtendLease(ctx); err != nil {
					return fmt.Errorf("extend lease: %w", err)
				}
			}
		}
		return nil
	}
}

// HTTPPostPayload is the payload of an http.post job.
type HTTPPostPayload struct {
	URL     string            `json:"url"`
	Body    json.RawMessage   `json:"body"`
	Headers map[string]string `json:"headers"`
}

// HTTPPost returns a handler that POSTs the payload's body, as JSON, to the payload's URL.
// A 2xx response completes the job. 408, 429 and 5xx responses and transport errors are
// retried; other responses, and payloads that cannot be sent at all, fail the job permanently.
func HTTPPost(client *http.Client) worker.HandlerFunc {
	return func(ctx context.Context, job domain.Job) error {
		var p HTTPPostPayload
		if err := json.Unmarshal(job.Payload, &p); err != nil {
			return domain.Permanent(fmt.Errorf("decode payload: %w", err))
		}
		target, err := url.Parse(p.URL)
		if err != nil || (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" {
			return domain.Permanent(fmt.Errorf("payload url must be an absolute http or https URL, got %q", p.URL))
		}
		body := p.Body
		if len(body) == 0 {
			body = json.RawMessage(`null`)
		}

		req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
		if err != nil {
			return domain.Permanent(fmt.Errorf("build request: %w", err))
		}
		for k, v := range p.Headers {
			req.Header.Set(k, v)
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Idempotency-Key", fmt.Sprintf("jobqueue-%d", job.ID))

		resp, err := client.Do(req)
		if err != nil {
			return fmt.Errorf("post to %s: %w", target.Redacted(), err)
		}
		defer resp.Body.Close()
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, maxErrorBody))
		// Drain what is left (up to a bound) so that the connection can be reused.
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))

		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			return nil
		}
		err = fmt.Errorf("post to %s: %s: %s", target.Redacted(), resp.Status, strings.TrimSpace(string(snippet)))
		if retryable(resp.StatusCode) {
			return err
		}
		return domain.Permanent(err)
	}
}

func retryable(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooManyRequests || status >= 500
}
