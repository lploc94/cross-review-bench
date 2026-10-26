package proxy

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/relaywork/gateway/internal/core"
)

// errUpstreamTimeout is the cancellation cause of an attempt whose upstream did not send
// response headers within the route's timeout.
var errUpstreamTimeout = errors.New("upstream did not respond in time")

// States of an attempt's deadline.
const (
	deadlinePending int32 = iota
	deadlineMet           // the response headers arrived (or the attempt failed) first
	deadlineExpired       // the route's timeout fired first
)

// attemptResult is the outcome of sending a request to one upstream once.
type attemptResult struct {
	resp     *http.Response
	release  context.CancelCauseFunc // ends the attempt's context once the response is done
	err      error
	class    core.ErrorClass // why err happened
	canceled bool            // the client went away; says nothing about the upstream
}

// outcome is what the attempt tells the upstream's circuit breaker.
func (a *attemptResult) outcome() core.Outcome {
	switch {
	case a.canceled:
		return core.Ignored
	case a.err != nil, a.resp.StatusCode >= 500:
		return core.Failure
	}
	return core.Success
}

// retryable reports whether the policy retries this outcome.
func (a *attemptResult) retryable(p core.RetryPolicy) bool {
	switch {
	case a.canceled:
		return false
	case a.err != nil:
		return p.RetryError(a.class)
	}
	return p.RetryStatus(a.resp.StatusCode)
}

// discard drops a response that will not be relayed.
func (a *attemptResult) discard() {
	if a.resp != nil {
		a.resp.Body.Close()
	}
	if a.release != nil {
		a.release(nil)
	}
}

// forward sends the request to the route's upstreams, retrying as the route's policy allows,
// and relays the last response or error to the client.
//
// A request is retried only when its body can be sent again (it was buffered), its method is
// idempotent or the route opts in, and the failure is one the policy names. Each retry waits
// for the policy's backoff and prefers an upstream not tried yet.
func (h *Handler) forward(w *statusRecorder, ex *exchange, body *requestBody) {
	route := ex.route
	attempts := 1
	if body.replayable && route.Retry.Retries(ex.req.Method) {
		attempts = route.Retry.Attempts
	}
	tried := make(map[*core.Upstream]bool, attempts)
	var last *attemptResult
	for n := 1; n <= attempts; n++ {
		if n > 1 {
			if !h.sleep(ex.req.Context(), route.Retry.Delay(n-1, h.rand)) {
				break // the client went away during the backoff
			}
			h.metrics.retries.Inc(route.ID)
		}
		u, ticket, gerr := h.pick(route, tried)
		if gerr != nil {
			if last != nil {
				break // nowhere to retry; relay what the last attempt got
			}
			h.fail(w, ex, gerr)
			return
		}
		if last != nil {
			last.discard()
		}
		tried[u] = true
		ex.upstream, ex.attempts = u, n
		last = h.attempt(ex, u, body)
		ticket.Done(last.outcome())
		if !last.retryable(route.Retry) {
			break
		}
	}
	h.respond(w, ex, last)
}

// sleep waits for d on the handler's clock, or until ctx is done. It reports whether the full
// delay passed.
func (h *Handler) sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	select {
	case <-ctx.Done():
		return false
	case <-h.clock.After(d):
		return true
	}
}

// pick chooses the upstream for the next attempt: a healthy upstream whose circuit breaker
// admits the request, preferring upstreams not tried yet for this request.
func (h *Handler) pick(route *core.Route, tried map[*core.Upstream]bool) (*core.Upstream, core.Ticket, *gatewayError) {
	rejected := make(map[*core.Upstream]bool)
	healthy := false
	for _, untriedOnly := range []bool{true, false} {
		for {
			u := route.Next(func(u *core.Upstream) bool {
				return rejected[u] || (untriedOnly && tried[u])
			})
			if u == nil {
				break
			}
			healthy = true
			ticket, err := u.Breaker.Allow()
			if err == nil {
				return u, ticket, nil
			}
			rejected[u] = true
		}
	}
	if healthy {
		return nil, core.Ticket{}, newError(http.StatusServiceUnavailable, codeCircuitOpen,
			"the route's upstreams are failing; try again later")
	}
	return nil, core.Ticket{}, newError(http.StatusServiceUnavailable, codeNoHealthyUpstream,
		"the route has no healthy upstream")
}

// attempt sends the request to u once. The route's timeout covers the time until the response
// headers arrive; the response body streams for as long as it takes.
func (h *Handler) attempt(ex *exchange, u *core.Upstream, body *requestBody) *attemptResult {
	r := ex.req
	ctx, cancel := context.WithCancelCause(r.Context())
	// deadline settles the race between the timeout and the response headers: whichever
	// claims it first decides the attempt, so a timer that fires just as the headers arrive
	// can never cancel a response that is already being relayed.
	content, length, ok := body.forAttempt()
	if !ok {
		// Not reachable: forward only makes one attempt with a streamed body.
		cancel(nil)
		return &attemptResult{err: errors.New("request body already sent"), class: core.ErrReset}
	}
	var stream *clientStream
	if !body.replayable {
		stream = &clientStream{ReadCloser: content, rc: ex.rc}
		content = stream
	}
	var deadline atomic.Int32
	timer := h.clock.AfterFunc(ex.route.Timeout, func() {
		if deadline.CompareAndSwap(deadlinePending, deadlineExpired) {
			cancel(errUpstreamTimeout)
			if stream != nil {
				// The transport ends a cancelled attempt only once the read of the body it is
				// waiting on returns.
				stream.interrupt()
			}
		}
	})
	target := *u.URL
	path, rawPath := ex.route.ForwardPath(r.URL)
	target.Path, target.RawPath = joinPath(u.URL, path, rawPath)
	target.RawQuery = r.URL.RawQuery
	target.ForceQuery = false
	target.Fragment, target.RawFragment = "", ""

	trailer, withTrailer := outboundTrailer(r, ex.route, ex.strip, ex.client)
	if trailer != nil {
		// Trailers travel only in a chunked body: an unknown length and a body that is not
		// nil, even when empty, make the transport chunk.
		length = -1
		if content == nil {
			content = io.NopCloser(strings.NewReader(""))
		}
		content = withTrailer(content)
	}
	out := (&http.Request{
		Method:        r.Method,
		URL:           &target,
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        outboundHeader(r.Header, ex.route, ex.strip, ex.client, ex.id, ex.consumer.ID),
		Body:          content,
		ContentLength: length,
		Trailer:       trailer,
		Host:          target.Host,
	}).WithContext(ctx)
	if body.replayable && content != nil {
		// Lets the transport resend the body when a reused connection turns out to be closed.
		out.GetBody = func() (io.ReadCloser, error) {
			rc, _, _ := body.forAttempt()
			if rc == nil {
				rc = io.NopCloser(strings.NewReader(""))
			}
			if withTrailer != nil {
				rc = withTrailer(rc)
			}
			return rc, nil
		}
	}

	start := h.clock.Now()
	resp, err := h.transport.RoundTrip(out)
	timer.Stop()
	if stream != nil && stream.interrupted.Load() {
		// What is left of the body is still on the client's connection, which cannot carry
		// another request.
		ex.headers.Set("Connection", "close")
	}
	if !deadline.CompareAndSwap(deadlinePending, deadlineMet) {
		// The timeout fired while the headers were arriving: treat the attempt as timed out
		// rather than relay a response whose context is cancelled.
		if err == nil {
			resp.Body.Close()
		}
		err = errUpstreamTimeout
	}
	if err != nil {
		res := &attemptResult{err: err}
		res.class, res.canceled = classify(ctx, r.Context(), err)
		cancel(nil)
		return res
	}
	h.metrics.upstreamLatency.Observe(h.clock.Now().Sub(start).Seconds(), ex.route.ID)
	return &attemptResult{resp: resp, release: cancel}
}

// classify sorts a failed attempt: a timeout of the route's own deadline, the client going
// away, a failure to connect, or a connection that broke before the response.
func classify(attemptCtx, clientCtx context.Context, err error) (class core.ErrorClass, canceled bool) {
	if errors.Is(context.Cause(attemptCtx), errUpstreamTimeout) || errors.Is(err, errUpstreamTimeout) {
		return core.ErrTimeout, false
	}
	if clientCtx.Err() != nil {
		return "", true
	}
	var opErr *net.OpError
	var dnsErr *net.DNSError
	switch {
	case errors.As(err, &opErr) && opErr.Op == "dial",
		errors.As(err, &dnsErr),
		errors.Is(err, syscall.ECONNREFUSED):
		return core.ErrConnect, false
	}
	return core.ErrReset, false
}

// joinPath appends the forwarded path to the upstream's base path. rawPath, when not empty, is
// the escaped form of path. The joined raw path keeps the escaping of both parts, and is ""
// when the default escaping of the joined path gives the same result.
func joinPath(base *url.URL, path, rawPath string) (joined, joinedRaw string) {
	if path == "" {
		if base.Path == "" {
			return "/", ""
		}
		return base.Path, base.RawPath
	}
	// A trailing slash of the base is dropped only when it is a literal one: an escaped slash
	// (%2F) at the end is part of the base path, and dropping it from Path alone would leave a raw
	// form that no longer encodes the joined path.
	escBase, basePath := base.EscapedPath(), base.Path
	if strings.HasSuffix(escBase, "/") {
		escBase, basePath = strings.TrimSuffix(escBase, "/"), strings.TrimSuffix(basePath, "/")
	}
	joined = basePath + path
	// A raw form that is not a valid escaping (it has "{", "}" or "|" as sent) would make the
	// joined raw path invalid too, and net/url would then escape the base afresh, losing its
	// escaping. EscapedPath gives the raw form when it is valid and a clean escaping otherwise.
	rawPath = (&url.URL{Path: path, RawPath: rawPath}).EscapedPath()
	joinedRaw = escBase + rawPath
	if joinedRaw == (&url.URL{Path: joined}).EscapedPath() {
		joinedRaw = ""
	}
	return joined, joinedRaw
}

// clientStream is a request body that an attempt reads from the client while the transport sends
// it. A client that stops sending leaves that read waiting; interrupt makes it fail at once.
type clientStream struct {
	io.ReadCloser
	rc          *http.ResponseController
	ended       atomic.Bool // the read returned EOF or failed
	interrupted atomic.Bool
}

func (s *clientStream) Read(p []byte) (int, error) {
	n, err := s.ReadCloser.Read(p)
	if err != nil {
		s.ended.Store(true)
	}
	return n, err
}

// interrupt makes a read of a body that has not ended fail now, by moving the client
// connection's read deadline to the present. A writer that is not a connection (a test
// recorder) does not support it, and its reads do not wait on a client.
func (s *clientStream) interrupt() {
	if s.ended.Load() {
		return
	}
	s.interrupted.Store(true)
	_ = s.rc.SetReadDeadline(time.Now())
}
