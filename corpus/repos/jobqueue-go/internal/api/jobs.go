package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/store"
)

// jobJSON is the API representation of a job.
type jobJSON struct {
	ID          int64           `json:"id"`
	Queue       string          `json:"queue"`
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload"`
	Priority    int             `json:"priority"`
	State       domain.State    `json:"state"`
	Attempts    int             `json:"attempts"`
	MaxAttempts int             `json:"max_attempts"`
	RunAt       time.Time       `json:"run_at"`
	LockedBy    *string         `json:"locked_by"`
	LockedUntil *time.Time      `json:"locked_until"`
	LastError   *string         `json:"last_error"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
	FinishedAt  *time.Time      `json:"finished_at"`
}

func toJobJSON(j domain.Job) jobJSON {
	return jobJSON{
		ID:          j.ID,
		Queue:       j.Queue,
		Type:        j.Type,
		Payload:     j.Payload,
		Priority:    j.Priority,
		State:       j.State,
		Attempts:    j.Attempts,
		MaxAttempts: j.MaxAttempts,
		RunAt:       j.RunAt,
		LockedBy:    optional(j.LockedBy),
		LockedUntil: j.LockedUntil,
		LastError:   optional(j.LastError),
		CreatedAt:   j.CreatedAt,
		UpdatedAt:   j.UpdatedAt,
		FinishedAt:  j.FinishedAt,
	}
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// jobPageJSON is one page of a job listing. NextAfter is the after parameter for the next
// page, or null on the last page.
type jobPageJSON struct {
	Jobs      []jobJSON `json:"jobs"`
	NextAfter *int64    `json:"next_after"`
}

func toJobPageJSON(p store.Page) jobPageJSON {
	out := jobPageJSON{Jobs: make([]jobJSON, len(p.Jobs))}
	for i, j := range p.Jobs {
		out.Jobs[i] = toJobJSON(j)
	}
	if p.NextAfter != 0 {
		out.NextAfter = &p.NextAfter
	}
	return out
}

type enqueueRequest struct {
	Type        string          `json:"type"`
	Payload     json.RawMessage `json:"payload"`
	Priority    int             `json:"priority"`
	MaxAttempts int             `json:"max_attempts"`
	RunAt       *time.Time      `json:"run_at"`
}

// POST /v1/queues/{queue}/jobs
func (s *Server) enqueueJob(w http.ResponseWriter, r *http.Request) error {
	var req enqueueRequest
	if err := decodeJSON(w, r, &req); err != nil {
		return err
	}
	nj := domain.NewJob{
		Queue:       r.PathValue("queue"),
		Type:        req.Type,
		Payload:     req.Payload,
		Priority:    req.Priority,
		MaxAttempts: req.MaxAttempts,
	}
	if req.RunAt != nil {
		nj.RunAt = *req.RunAt
	}
	job, err := s.store.Enqueue(r.Context(), nj)
	if err != nil {
		return err
	}
	w.Header().Set("Location", "/v1/jobs/"+strconv.FormatInt(job.ID, 10))
	s.writeJSON(w, http.StatusCreated, toJobJSON(job))
	return nil
}

// GET /v1/jobs/{id}
func (s *Server) getJob(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r)
	if err != nil {
		return err
	}
	job, err := s.store.Get(r.Context(), id)
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, toJobJSON(job))
	return nil
}

// GET /v1/jobs?queue=&state=&after=&limit=
func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) error {
	v := &domain.ValidationError{}
	f := store.ListFilter{Queue: r.URL.Query().Get("queue")}
	if f.Queue != "" {
		if err := domain.ValidateQueueName(f.Queue); err != nil {
			v.Add("queue", "%s", err)
		}
	}
	if raw := r.URL.Query().Get("state"); raw != "" {
		st, err := domain.ParseState(raw)
		if err != nil {
			v.Add("state", "%s", err)
		}
		f.State = st
	}
	f.After, f.Limit = pageParams(r, v)
	if err := v.Err(); err != nil {
		return err
	}
	page, err := s.store.List(r.Context(), f)
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, toJobPageJSON(page))
	return nil
}

// POST /v1/jobs/{id}/cancel
func (s *Server) cancelJob(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r)
	if err != nil {
		return err
	}
	job, err := s.store.Cancel(r.Context(), id)
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, toJobJSON(job))
	return nil
}

// GET /v1/dead?queue=&after=&limit=
func (s *Server) listDead(w http.ResponseWriter, r *http.Request) error {
	v := &domain.ValidationError{}
	queue := r.URL.Query().Get("queue")
	if queue != "" {
		if err := domain.ValidateQueueName(queue); err != nil {
			v.Add("queue", "%s", err)
		}
	}
	after, limit := pageParams(r, v)
	if err := v.Err(); err != nil {
		return err
	}
	page, err := s.store.ListDead(r.Context(), queue, after, limit)
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, toJobPageJSON(page))
	return nil
}

// POST /v1/dead/{id}/requeue
func (s *Server) requeueJob(w http.ResponseWriter, r *http.Request) error {
	id, err := pathID(r)
	if err != nil {
		return err
	}
	job, err := s.store.Requeue(r.Context(), id)
	if err != nil {
		return err
	}
	s.writeJSON(w, http.StatusOK, toJobJSON(job))
	return nil
}
