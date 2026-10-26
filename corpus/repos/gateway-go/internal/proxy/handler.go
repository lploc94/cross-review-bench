// Package proxy is the gateway's request path: it matches each request to a route,
// authenticates and rate-limits it, forwards it to an upstream with retries and circuit
// breaking, and streams the response back.
package proxy

import (
	"errors"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/relaywork/gateway/internal/auth"
	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/header"
	"github.com/relaywork/gateway/internal/metrics"
	"github.com/relaywork/gateway/internal/model"
)

// TableSource provides the live route table; *core.Runtime implements it.
type TableSource interface {
	Table() *core.Table
}

// Options configure a Handler.
type Options struct {
	Routes TableSource
	// Auth holds an authenticator for each auth mode routes may name, other than "none".
	Auth auth.Modes
	// RateLimiter counts requests of routes with a rate limit. When it fails, requests are let
	// through (the gateway fails open) and the failure is logged and counted.
	RateLimiter core.RateLimiter
	// Transport sends requests to upstreams.
	Transport http.RoundTripper
	Clock     clock.Clock
	// Rand jitters retry backoff; nil means math/rand/v2.
	Rand    core.Rand
	Logger  *slog.Logger
	Metrics *metrics.Registry // optional
	// TrustedProxies are the peers whose X-Forwarded-* headers are believed.
	TrustedProxies []netip.Prefix
	// BodyBufferLimit bounds the request bodies held in memory for retries and signatures.
	BodyBufferLimit int64
}

// Handler is the proxy's http.Handler.
type Handler struct {
	routes    TableSource
	auth      auth.Modes
	limiter   core.RateLimiter
	transport http.RoundTripper
	clock     clock.Clock
	rand      core.Rand
	log       *slog.Logger
	metrics   proxyMetrics
	trusted   trustedProxies
	bodyLimit int64
}

// New validates the options and returns a handler.
func New(o Options) (*Handler, error) {
	if o.Routes == nil || o.Transport == nil || o.Clock == nil || o.Logger == nil {
		return nil, errors.New("proxy: Routes, Transport, Clock and Logger are required")
	}
	if o.BodyBufferLimit < 0 {
		return nil, errors.New("proxy: BodyBufferLimit must not be negative")
	}
	rnd := o.Rand
	if rnd == nil {
		rnd = globalRand{}
	}
	reg := o.Metrics
	if reg == nil {
		reg = metrics.NewRegistry()
	}
	return &Handler{
		routes:    o.Routes,
		auth:      o.Auth,
		limiter:   o.RateLimiter,
		transport: o.Transport,
		clock:     o.Clock,
		rand:      rnd,
		log:       o.Logger,
		metrics:   newProxyMetrics(reg),
		trusted:   trustedProxies(o.TrustedProxies),
		bodyLimit: o.BodyBufferLimit,
	}, nil
}

// globalRand uses the top-level functions of math/rand/v2, which are safe for concurrent use.
type globalRand struct{}

func (globalRand) Int64N(n int64) int64 { return rand.Int64N(n) }

// exchange is the state of one request as it moves through the handler.
type exchange struct {
	req      *http.Request
	id       string
	start    time.Time
	route    *core.Route
	client   clientInfo
	consumer model.Consumer
	strip    []string       // credential headers not to forward
	headers  http.Header    // gateway headers for the client's response
	upstream *core.Upstream // of the last attempt
	attempts int
	err      error // why the gateway answered itself, for the log
	// rc reaches the client's connection, so that an attempt can stop waiting on a request body
	// the client has stopped sending.
	rc *http.ResponseController
}

// ServeHTTP proxies one request.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ex := &exchange{req: r, id: requestID(r), start: h.clock.Now(), headers: make(http.Header),
		rc: http.NewResponseController(w)}
	ex.headers.Set(header.RequestID, ex.id)
	rec := &statusRecorder{ResponseWriter: w}
	defer h.finish(rec, ex)
	h.serve(rec, ex)
}

func (h *Handler) serve(w *statusRecorder, ex *exchange) {
	r := ex.req
	ex.client = h.trusted.resolveClient(r)
	if !config.IsCleanPath(r.URL.Path) {
		h.fail(w, ex, newError(http.StatusBadRequest, codeBadRequest,
			"the request path must be absolute, without empty, '.' or '..' segments"))
		return
	}
	route, err := h.routes.Table().Match(r.Host, r.URL.Path, r.Method)
	if err != nil {
		var mna *core.MethodNotAllowedError
		if errors.As(err, &mna) {
			ex.headers.Set("Allow", strings.Join(mna.Allow, ", "))
			h.fail(w, ex, newError(http.StatusMethodNotAllowed, codeMethodNotAllowed, "the route does not accept "+r.Method))
			return
		}
		h.fail(w, ex, newError(http.StatusNotFound, codeRouteNotFound, "no route matches the request"))
		return
	}
	ex.route = route

	body, ok := h.authenticate(w, ex)
	if !ok {
		return
	}
	if !h.rateLimit(w, ex) {
		return
	}
	if body == nil {
		var err error
		if route.Retry.Retries(r.Method) {
			body, err = retryableBody(r, h.bodyLimit)
		} else {
			body = streamBody(r)
		}
		if err != nil {
			h.fail(w, ex, newError(http.StatusBadRequest, codeBadRequest, "the request body could not be read"))
			return
		}
	}
	h.forward(w, ex, body)
}

// authenticate runs the route's authenticator. It returns the request body when the
// authenticator needed it buffered, and false when it has answered the request.
func (h *Handler) authenticate(w *statusRecorder, ex *exchange) (*requestBody, bool) {
	route := ex.route
	if route.Auth == config.AuthNone {
		return nil, true
	}
	authn := h.auth[route.Auth]
	if authn == nil {
		h.fail(w, ex, newError(http.StatusInternalServerError, codeAuthUnavailable, "the route's authentication mode is not available"))
		h.log.Error("no authenticator for auth mode", "route", route.ID, "auth", route.Auth)
		return nil, false
	}
	ex.strip = authn.StripHeaders()

	var body *requestBody
	if authn.NeedsBody() {
		var err error
		body, err = bufferBody(ex.req, h.bodyLimit)
		switch {
		case errors.Is(err, errBodyTooLarge):
			h.fail(w, ex, newError(http.StatusRequestEntityTooLarge, codeBodyTooLarge,
				"the request body exceeds "+strconv.FormatInt(h.bodyLimit, 10)+" bytes"))
			return nil, false
		case err != nil:
			h.fail(w, ex, newError(http.StatusBadRequest, codeBadRequest, "the request body could not be read"))
			return nil, false
		}
	}
	var content []byte
	if body != nil {
		content = body.content()
	}
	consumer, err := authn.Authenticate(ex.req.Context(), ex.req, content)
	if err != nil {
		h.authFailed(w, ex, err)
		return nil, false
	}
	ex.consumer = consumer
	return body, true
}

func (h *Handler) authFailed(w *statusRecorder, ex *exchange, err error) {
	ex.err = err
	if !auth.IsAuthError(err) {
		h.log.Error("authentication unavailable", "route", ex.route.ID, "error", err, "request_id", ex.id)
		h.fail(w, ex, newError(http.StatusServiceUnavailable, codeAuthUnavailable, "credentials cannot be checked right now"))
		return
	}
	scheme := "Bearer"
	if ex.route.Auth == config.AuthHMAC {
		scheme = auth.HMACScheme
	}
	ex.headers.Set("WWW-Authenticate", scheme+` realm="gateway"`)
	var ge *gatewayError
	switch {
	case errors.Is(err, auth.ErrMissingCredentials):
		ge = newError(http.StatusUnauthorized, codeMissingCreds, "the route requires credentials")
	case errors.Is(err, auth.ErrStaleSignature):
		ge = newError(http.StatusUnauthorized, codeStaleSignature, "the signature timestamp is too far from the gateway's clock")
	default:
		ge = newError(http.StatusUnauthorized, codeInvalidCreds, "the credentials are not valid")
	}
	h.metrics.authFailures.Inc(ex.route.ID, ge.code)
	h.fail(w, ex, ge)
}

// rateLimit applies the route's rate limit, if any, to the consumer, or to the client address
// on routes without authentication. It returns false when it has answered the request.
func (h *Handler) rateLimit(w *statusRecorder, ex *exchange) bool {
	route := ex.route
	if route.RateLimit == nil || h.limiter == nil {
		return true
	}
	key := "ip:" + ex.client.ip
	if ex.consumer.ID != "" {
		key = "consumer:" + ex.consumer.ID
	}
	d, err := h.limiter.Allow(ex.req.Context(), route.ID, key, *route.RateLimit)
	if err != nil {
		h.metrics.rateLimitErrors.Inc(route.ID)
		h.log.Warn("rate limiter unavailable; request let through", "route", route.ID, "error", err, "request_id", ex.id)
		return true
	}
	reset := ceilSeconds(d.Reset)
	ex.headers.Set("RateLimit-Limit", strconv.Itoa(d.Limit))
	ex.headers.Set("RateLimit-Remaining", strconv.Itoa(d.Remaining))
	ex.headers.Set("RateLimit-Reset", strconv.FormatInt(reset, 10))
	if d.Allowed {
		return true
	}
	ex.headers.Set("Retry-After", strconv.FormatInt(reset, 10))
	h.metrics.rateLimited.Inc(route.ID)
	h.fail(w, ex, newError(http.StatusTooManyRequests, codeRateLimited, "rate limit exceeded; retry after the window resets"))
	return false
}

// ceilSeconds rounds d up to whole seconds, at least 1.
func ceilSeconds(d time.Duration) int64 {
	s := int64((d + time.Second - 1) / time.Second)
	return max(s, 1)
}

// fail answers the request with a gateway error.
func (h *Handler) fail(w *statusRecorder, ex *exchange, e *gatewayError) {
	if ex.err == nil {
		ex.err = e
	}
	for name, values := range ex.headers {
		w.Header()[name] = values
	}
	writeError(w, e, ex.id)
}

// finish records the request in the metrics and the access log.
func (h *Handler) finish(w *statusRecorder, ex *exchange) {
	status := w.status
	if !w.wroteHeader {
		status = statusClientClosed
	}
	routeID := "unmatched"
	if ex.route != nil {
		routeID = ex.route.ID
	}
	h.metrics.requests.Inc(routeID, statusClass(status))

	attrs := []any{
		"method", ex.req.Method,
		"path", ex.req.URL.Path,
		"host", ex.req.Host,
		"route", routeID,
		"status", status,
		"bytes", w.bytes,
		"duration", h.clock.Now().Sub(ex.start),
		"client_ip", ex.client.ip,
		"request_id", ex.id,
	}
	if ex.consumer.ID != "" {
		attrs = append(attrs, "consumer_id", ex.consumer.ID)
	}
	if ex.upstream != nil {
		attrs = append(attrs, "upstream", ex.upstream.String(), "attempts", ex.attempts)
	}
	if ex.err != nil {
		attrs = append(attrs, "error", ex.err.Error())
	}
	h.log.Info("request", attrs...)
}

// statusClientClosed is logged for requests whose client went away before any response.
const statusClientClosed = 499

func statusClass(status int) string {
	if status < 100 || status > 599 {
		return "other"
	}
	return strconv.Itoa(status/100) + "xx"
}
