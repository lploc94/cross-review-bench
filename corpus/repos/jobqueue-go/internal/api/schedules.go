package api

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
)

// scheduleJSON is the API representation of a schedule.
type scheduleJSON struct {
	Name      string          `json:"name"`
	Spec      string          `json:"spec"`
	Queue     string          `json:"queue"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	Enabled   bool            `json:"enabled"`
	NextRunAt time.Time       `json:"next_run_at"`
	LastRunAt *time.Time      `json:"last_run_at"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

func toScheduleJSON(sc domain.Schedule) scheduleJSON {
	return scheduleJSON{
		Name:      sc.Name,
		Spec:      sc.Spec,
		Queue:     sc.Queue,
		Type:      sc.Type,
		Payload:   sc.Payload,
		Enabled:   sc.Enabled,
		NextRunAt: sc.NextRunAt,
		LastRunAt: sc.LastRunAt,
		CreatedAt: sc.CreatedAt,
		UpdatedAt: sc.UpdatedAt,
	}
}

type putScheduleRequest struct {
	Spec    string          `json:"spec"`
	Queue   string          `json:"queue"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
	Enabled *bool           `json:"enabled"` // default true
}

// GET /v1/schedules
func (s *Server) listSchedules(w http.ResponseWriter, r *http.Request) error {
	list, err := s.store.ListSchedules(r.Context())
	if err != nil {
		return err
	}
	out := struct {
		Schedules []scheduleJSON `json:"schedules"`
	}{Schedules: make([]scheduleJSON, len(list))}
	for i, sc := range list {
		out.Schedules[i] = toScheduleJSON(sc)
	}
	s.writeJSON(w, http.StatusOK, out)
	return nil
}

// GET /v1/schedules/{name}
func (s *Server) getSchedule(w http.ResponseWriter, r *http.Request) error {
	sc, err := s.store.GetSchedule(r.Context(), r.PathValue("name"))
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, toScheduleJSON(sc))
	return nil
}

// PUT /v1/schedules/{name} creates the schedule or replaces it entirely.
func (s *Server) putSchedule(w http.ResponseWriter, r *http.Request) error {
	var req putScheduleRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	in := domain.ScheduleInput{
		Name:    r.PathValue("name"),
		Spec:    req.Spec,
		Queue:   req.Queue,
		Type:    req.Type,
		Payload: req.Payload,
		Enabled: req.Enabled == nil || *req.Enabled,
	}.Normalize()
	expr, err := in.Validate()
	if err != nil {
		return err
	}
	first, err := domain.FirstRun(expr, s.clock.Now())
	if err != nil {
		return err
	}
	sc, created, err := s.store.PutSchedule(r.Context(), in, first)
	if err != nil {
		return err
	}
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	s.writeJSON(w, status, toScheduleJSON(sc))
	return nil
}

// DELETE /v1/schedules/{name}
func (s *Server) deleteSchedule(w http.ResponseWriter, r *http.Request) error {
	if err := s.store.DeleteSchedule(r.Context(), r.PathValue("name")); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}
