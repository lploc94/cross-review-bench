package api

import (
	"context"
	"net/http"
	"time"
)

// healthTimeout bounds the database check of /healthz, so that a load balancer probe gets an
// answer even when the database hangs.
const healthTimeout = 2 * time.Second

// GET /healthz reports whether the service can reach its database.
func (s *Server) health(w http.ResponseWriter, r *http.Request) error {
	ctx, cancel := context.WithTimeout(r.Context(), healthTimeout)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		s.log.Warn("health check failed", "error", err)
		s.writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "unavailable"})
		return nil
	}
	s.writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	return nil
}
