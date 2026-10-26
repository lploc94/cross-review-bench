// Package api serves the HTTP JSON API under /v1, plus /healthz and /metrics.
package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/metrics"
	"github.com/relaywork/jobqueue/internal/store"
)

// Store is the part of the store the API needs.
type Store interface {
	Ping(ctx context.Context) error

	Enqueue(ctx context.Context, nj domain.NewJob) (domain.Job, error)
	Get(ctx context.Context, id int64) (domain.Job, error)
	List(ctx context.Context, f store.ListFilter) (store.Page, error)
	Cancel(ctx context.Context, id int64) (domain.Job, error)
	ListDead(ctx context.Context, queue string, after int64, limit int) (store.Page, error)
	Requeue(ctx context.Context, id int64) (domain.Job, error)

	GetSchedule(ctx context.Context, name string) (domain.Schedule, error)
	ListSchedules(ctx context.Context) ([]domain.Schedule, error)
	PutSchedule(ctx context.Context, in domain.ScheduleInput, firstRun time.Time) (domain.Schedule, bool, error)
	DeleteSchedule(ctx context.Context, name string) error
}

// Options configures a Server.
type Options struct {
	Store      Store
	AdminToken string // required on every /v1 route as "Authorization: Bearer <token>"
	Clock      clock.Clock
	Logger     *slog.Logger
	Metrics    *metrics.Registry // served on /metrics; optional
}

// Server routes and serves API requests.
type Server struct {
	store   Store
	clock   clock.Clock
	log     *slog.Logger
	auth    *authenticator
	metrics *metrics.Registry
	httpm   httpMetrics
	mux     *http.ServeMux
	handler http.Handler
}

// New returns a Server with every route registered.
func New(opts Options) (*Server, error) {
	if opts.Store == nil {
		return nil, errors.New("api: store is required")
	}
	if opts.AdminToken == "" {
		return nil, errors.New("api: admin token is required")
	}
	if opts.Clock == nil {
		opts.Clock = clock.Real{}
	}
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	if opts.Metrics == nil {
		opts.Metrics = metrics.NewRegistry()
	}
	s := &Server{
		store:   opts.Store,
		clock:   opts.Clock,
		log:     opts.Logger.With("component", "api"),
		auth:    newAuthenticator(opts.AdminToken),
		metrics: opts.Metrics,
		httpm:   newHTTPMetrics(opts.Metrics),
		mux:     http.NewServeMux(),
	}
	s.routes()
	s.handler = s.withRequestID(s.mux)
	return s, nil
}

// routes registers every endpoint. Routes under /v1 require the admin token.
func (s *Server) routes() {
	s.public("GET /healthz", s.health)
	s.mux.Handle("GET /metrics", s.metrics.Handler())

	s.private("POST /v1/queues/{queue}/jobs", s.enqueueJob)
	s.private("GET /v1/jobs", s.listJobs)
	s.private("GET /v1/jobs/{id}", s.getJob)
	s.private("POST /v1/jobs/{id}/cancel", s.cancelJob)

	s.private("GET /v1/dead", s.listDead)
	s.private("POST /v1/dead/{id}/requeue", s.requeueJob)

	s.private("GET /v1/schedules", s.listSchedules)
	s.private("GET /v1/schedules/{name}", s.getSchedule)
	s.private("PUT /v1/schedules/{name}", s.putSchedule)
	s.private("DELETE /v1/schedules/{name}", s.deleteSchedule)
}

// ServeHTTP implements http.Handler.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

// handlerFunc is an endpoint that returns its error instead of writing it, so that every error
// is reported in the same JSON shape.
type handlerFunc func(w http.ResponseWriter, r *http.Request) error

func (s *Server) public(pattern string, h handlerFunc) {
	s.mux.Handle(pattern, s.instrument(pattern, s.recoverPanics(s.adapt(h))))
}

func (s *Server) private(pattern string, h handlerFunc) {
	s.mux.Handle(pattern, s.instrument(pattern, s.recoverPanics(s.requireAuth(s.adapt(h)))))
}

func (s *Server) adapt(h handlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			s.writeError(w, r, err)
		}
	})
}
