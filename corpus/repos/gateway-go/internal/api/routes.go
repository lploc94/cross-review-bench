package api

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/model"
)

// pingTimeout bounds the Redis check of the health endpoints.
const pingTimeout = 2 * time.Second

// routeView is a route as the admin API shows it: its settings and the live state of its
// upstreams.
type routeView struct {
	config.Route
	UpstreamStatus []core.UpstreamStatus `json:"upstream_status"`
}

func viewOf(r *core.Route) routeView {
	return routeView{Route: r.Spec(), UpstreamStatus: r.Status()}
}

func (s *Server) listRoutes(w http.ResponseWriter, r *http.Request) {
	routes := s.routes.Table().Routes()
	views := make([]routeView, len(routes))
	for i, rt := range routes {
		views[i] = viewOf(rt)
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"routes": views})
}

func (s *Server) getRoute(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	rt, ok := s.routes.Table().Route(id)
	if !ok {
		s.writeError(w, r, fmt.Errorf("route %q: %w", id, model.ErrNotFound))
		return
	}
	s.writeJSON(w, http.StatusOK, viewOf(rt))
}

func (s *Server) reloadRoutes(w http.ResponseWriter, r *http.Request) {
	if s.reload == nil {
		s.writeError(w, r, errReloadDisabled)
		return
	}
	if err := s.reload(); err != nil {
		s.log.Warn("route reload rejected; keeping the live routes", "error", err, "request_id", requestID(r.Context()))
		s.writeError(w, r, &reloadError{err: err})
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]any{"routes": len(s.routes.Table().Routes())})
}

type healthReport struct {
	Status    string `json:"status"` // "ok" or "degraded"
	Redis     string `json:"redis"`  // "ok" or the error
	Routes    int    `json:"routes"`
	Unhealthy int    `json:"unhealthy_upstreams"`
}

func (s *Server) report(ctx context.Context) healthReport {
	rep := healthReport{Status: "ok", Redis: "ok"}
	ctx, cancel := context.WithTimeout(ctx, pingTimeout)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		rep.Status, rep.Redis = "degraded", err.Error()
	}
	for _, rt := range s.routes.Table().Routes() {
		rep.Routes++
		for _, u := range rt.Upstreams {
			if !u.Healthy() {
				rep.Unhealthy++
			}
		}
	}
	return rep
}

// health reports Redis and upstream health to operators.
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	rep := s.report(r.Context())
	status := http.StatusOK
	if rep.Status != "ok" {
		status = http.StatusServiceUnavailable
	}
	s.writeJSON(w, status, rep)
}

// liveness answers as long as the process serves HTTP.
func (s *Server) liveness(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = w.Write([]byte("ok\n"))
}

// readiness answers 200 when Redis answers and routes are loaded, 503 otherwise, so that a load
// balancer only sends traffic to a gateway that can serve it.
func (s *Server) readiness(w http.ResponseWriter, r *http.Request) {
	rep := s.report(r.Context())
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if rep.Status != "ok" || rep.Routes == 0 {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("not ready\n"))
		return
	}
	_, _ = w.Write([]byte("ready\n"))
}
