// Package api is the gateway's admin API, served on the admin listener next to /metrics: it
// manages consumers and their credentials, lists the live routes and reloads them, and reports
// health. Every /admin/v1 route requires the admin token.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/metrics"
	"github.com/relaywork/gateway/internal/model"
)

// Store is the persistence the admin API needs; *store.Store implements it.
type Store interface {
	Ping(ctx context.Context) error

	CreateConsumer(ctx context.Context, in model.ConsumerInput) (model.Consumer, error)
	GetConsumer(ctx context.Context, id string) (model.Consumer, error)
	UpdateConsumer(ctx context.Context, id string, patch model.ConsumerPatch) (model.Consumer, error)
	DeleteConsumer(ctx context.Context, id string) error
	ListConsumers(ctx context.Context, offset, limit int) ([]model.Consumer, int, error)

	IssueAPIKey(ctx context.Context, consumerID string) (string, model.APIKey, error)
	ListAPIKeys(ctx context.Context, consumerID string) ([]model.APIKey, error)
	RevokeAPIKey(ctx context.Context, consumerID, prefix string) error

	CreateHMACCredential(ctx context.Context, consumerID string) (model.HMACCredential, error)
	ListHMACCredentials(ctx context.Context, consumerID string) ([]model.HMACCredential, error)
	RevokeHMACCredential(ctx context.Context, consumerID, keyID string) error
}

// RouteSource provides the live route table; *core.Runtime implements it.
type RouteSource interface {
	Table() *core.Table
}

// Options configure a Server.
type Options struct {
	Store      Store
	Routes     RouteSource
	AdminToken string
	// Reload reloads the routes file. nil disables POST /admin/v1/routes/reload.
	Reload  func() error
	Clock   clock.Clock
	Logger  *slog.Logger
	Metrics *metrics.Registry // served on /metrics; optional
}

// Server is the admin HTTP handler.
type Server struct {
	store   Store
	routes  RouteSource
	reload  func() error
	clock   clock.Clock
	log     *slog.Logger
	auth    *authenticator
	httpm   httpMetrics
	handler http.Handler
}

// New validates the options and builds the router.
func New(o Options) (*Server, error) {
	if o.Store == nil || o.Routes == nil || o.Clock == nil || o.Logger == nil {
		return nil, errors.New("api: Store, Routes, Clock and Logger are required")
	}
	if o.AdminToken == "" {
		return nil, errors.New("api: AdminToken is required")
	}
	reg := o.Metrics
	if reg == nil {
		reg = metrics.NewRegistry()
	}
	s := &Server{
		store:  o.Store,
		routes: o.Routes,
		reload: o.Reload,
		clock:  o.Clock,
		log:    o.Logger,
		auth:   newAuthenticator(o.AdminToken),
		httpm:  newHTTPMetrics(reg),
	}

	mux := http.NewServeMux()
	// Panics are recovered inside instrument, so that a request that panicked is still
	// counted and logged, with its 500.
	handle := func(pattern string, h http.HandlerFunc) {
		mux.Handle(pattern, s.instrument(pattern, s.recoverPanics(s.requireAuth(h))))
	}
	handle("GET /admin/v1/health", s.health)
	handle("GET /admin/v1/routes", s.listRoutes)
	handle("GET /admin/v1/routes/{id}", s.getRoute)
	handle("POST /admin/v1/routes/reload", s.reloadRoutes)

	handle("POST /admin/v1/consumers", s.createConsumer)
	handle("GET /admin/v1/consumers", s.listConsumers)
	handle("GET /admin/v1/consumers/{id}", s.getConsumer)
	handle("PATCH /admin/v1/consumers/{id}", s.updateConsumer)
	handle("DELETE /admin/v1/consumers/{id}", s.deleteConsumer)

	handle("POST /admin/v1/consumers/{id}/keys", s.issueKey)
	handle("GET /admin/v1/consumers/{id}/keys", s.listKeys)
	handle("DELETE /admin/v1/consumers/{id}/keys/{prefix}", s.revokeKey)

	handle("POST /admin/v1/consumers/{id}/hmac-secrets", s.createHMACSecret)
	handle("GET /admin/v1/consumers/{id}/hmac-secrets", s.listHMACSecrets)
	handle("DELETE /admin/v1/consumers/{id}/hmac-secrets/{key_id}", s.revokeHMACSecret)

	mux.Handle("GET /healthz", s.instrument("GET /healthz", s.recoverPanics(http.HandlerFunc(s.liveness))))
	mux.Handle("GET /readyz", s.instrument("GET /readyz", s.recoverPanics(http.HandlerFunc(s.readiness))))
	if o.Metrics != nil {
		mux.Handle("GET /metrics", o.Metrics.Handler())
	}

	s.handler = s.withRequestID(s.recoverPanics(s.jsonMuxErrors(mux)))
	return s, nil
}

// jsonMuxErrors answers requests no pattern matches with the API's JSON errors instead of the
// mux's plain-text 404 and 405.
func (s *Server) jsonMuxErrors(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h, pattern := mux.Handler(r)
		if pattern != "" {
			mux.ServeHTTP(w, r)
			return
		}
		// Let the mux decide between 404 and 405 (setting Allow), but keep its body.
		capture := &statusCapture{header: make(http.Header)}
		h.ServeHTTP(capture, r)
		if capture.status == http.StatusMethodNotAllowed {
			w.Header().Set("Allow", capture.header.Get("Allow"))
			s.writeError(w, r, errMethodNotAllowed)
			return
		}
		s.writeError(w, r, errRouteNotFound)
	})
}

// statusCapture records the status a handler writes and discards everything else.
type statusCapture struct {
	header http.Header
	status int
}

func (c *statusCapture) Header() http.Header { return c.header }

func (c *statusCapture) WriteHeader(code int) {
	if c.status == 0 {
		c.status = code
	}
}

func (c *statusCapture) Write(b []byte) (int, error) {
	c.WriteHeader(http.StatusOK)
	return len(b), nil
}

// ServeHTTP serves the admin API.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}
