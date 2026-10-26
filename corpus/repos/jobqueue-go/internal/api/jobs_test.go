package api_test

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/domain"
)

type jobBody struct {
	ID          int64          `json:"id"`
	Queue       string         `json:"queue"`
	Type        string         `json:"type"`
	Payload     map[string]any `json:"payload"`
	Priority    int            `json:"priority"`
	State       string         `json:"state"`
	Attempts    int            `json:"attempts"`
	MaxAttempts int            `json:"max_attempts"`
	RunAt       time.Time      `json:"run_at"`
	LockedBy    *string        `json:"locked_by"`
	LastError   *string        `json:"last_error"`
	FinishedAt  *time.Time     `json:"finished_at"`
}

type pageBody struct {
	Jobs      []jobBody `json:"jobs"`
	NextAfter *int64    `json:"next_after"`
}

func TestEnqueueAndGetJob(t *testing.T) {
	e := newEnv(t)
	runAt := t0.Add(time.Hour).Format(time.RFC3339)
	rec := call(t, e.handler, http.MethodPost, "/v1/queues/emails/jobs",
		`{"type":"email.send","payload":{"to":"ops@example.com"},"priority":5,"max_attempts":3,"run_at":"`+runAt+`"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	job := decode[jobBody](t, rec)
	if loc := rec.Header().Get("Location"); loc != fmt.Sprintf("/v1/jobs/%d", job.ID) {
		t.Errorf("Location = %q", loc)
	}
	if job.Queue != "emails" || job.Type != "email.send" || job.Priority != 5 || job.MaxAttempts != 3 ||
		job.State != "available" || job.Payload["to"] != "ops@example.com" || job.RunAt.Format(time.RFC3339) != runAt {
		t.Errorf("created job = %+v", job)
	}
	if job.LockedBy != nil || job.LastError != nil || job.FinishedAt != nil {
		t.Errorf("unset fields are not null: %s", rec.Body)
	}

	rec = call(t, e.handler, http.MethodGet, fmt.Sprintf("/v1/jobs/%d", job.ID), "")
	if rec.Code != http.StatusOK || decode[jobBody](t, rec).ID != job.ID {
		t.Errorf("GET: %d %s", rec.Code, rec.Body)
	}
}

func TestEnqueueDefaults(t *testing.T) {
	e := newEnv(t)
	rec := call(t, e.handler, http.MethodPost, "/v1/queues/default/jobs", `{"type":"noop"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body)
	}
	job := decode[jobBody](t, rec)
	if job.MaxAttempts != domain.DefaultMaxAttempts || len(job.Payload) != 0 || !job.RunAt.Equal(t0) {
		t.Errorf("job = %+v", job)
	}
}

func TestEnqueueValidation(t *testing.T) {
	e := newEnv(t)
	rec := call(t, e.handler, http.MethodPost, "/v1/queues/Not%20Valid/jobs",
		`{"type":"","payload":[1],"priority":5000,"max_attempts":-1}`)
	resp := expectError(t, rec, http.StatusUnprocessableEntity, "validation_failed")
	if got := strings.Join(fieldNames(resp), ","); got != "queue,type,payload,priority,max_attempts" {
		t.Errorf("fields = %s", got)
	}
	page, err := e.store.List(context.Background(), storeAll())
	if err != nil || len(page.Jobs) != 0 {
		t.Errorf("invalid job was stored: %d jobs, %v", len(page.Jobs), err)
	}
}

func TestGetMissingJob(t *testing.T) {
	e := newEnv(t)
	expectError(t, call(t, e.handler, http.MethodGet, "/v1/jobs/4242", ""), http.StatusNotFound, "not_found")
}

func TestListJobs(t *testing.T) {
	e := newEnv(t)
	for i := range 5 {
		queue := "a"
		if i%2 == 1 {
			queue = "b"
		}
		call(t, e.handler, http.MethodPost, "/v1/queues/"+queue+"/jobs", `{"type":"noop"}`)
	}

	var ids []int64
	path := "/v1/jobs?limit=2"
	for range 10 {
		rec := call(t, e.handler, http.MethodGet, path, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s: %d %s", path, rec.Code, rec.Body)
		}
		page := decode[pageBody](t, rec)
		for _, j := range page.Jobs {
			ids = append(ids, j.ID)
		}
		if page.NextAfter == nil {
			break
		}
		path = fmt.Sprintf("/v1/jobs?limit=2&after=%d", *page.NextAfter)
	}
	if fmt.Sprint(ids) != "[1 2 3 4 5]" {
		t.Errorf("paged ids = %v", ids)
	}

	page := decode[pageBody](t, call(t, e.handler, http.MethodGet, "/v1/jobs?queue=b&state=available", ""))
	if len(page.Jobs) != 2 || page.Jobs[0].Queue != "b" || page.NextAfter != nil {
		t.Errorf("filtered page = %+v", page)
	}
	empty := call(t, e.handler, http.MethodGet, "/v1/jobs?queue=none", "")
	if !strings.Contains(empty.Body.String(), `"jobs":[]`) {
		t.Errorf("empty page body = %s, want an empty array", empty.Body)
	}
	expectError(t, call(t, e.handler, http.MethodGet, "/v1/jobs?limit=501", ""), http.StatusUnprocessableEntity, "validation_failed")
}

func TestCancelJob(t *testing.T) {
	e := newEnv(t)
	job := decode[jobBody](t, call(t, e.handler, http.MethodPost, "/v1/queues/default/jobs", `{"type":"noop"}`))
	path := fmt.Sprintf("/v1/jobs/%d/cancel", job.ID)

	rec := call(t, e.handler, http.MethodPost, path, "")
	if rec.Code != http.StatusOK || decode[jobBody](t, rec).State != "cancelled" {
		t.Fatalf("cancel: %d %s", rec.Code, rec.Body)
	}
	resp := expectError(t, call(t, e.handler, http.MethodPost, path, ""), http.StatusConflict, "conflict")
	if !strings.Contains(resp.Error.Message, "cancelled") {
		t.Errorf("conflict message = %q", resp.Error.Message)
	}
	expectError(t, call(t, e.handler, http.MethodPost, "/v1/jobs/999/cancel", ""), http.StatusNotFound, "not_found")
}

func TestDeadLetterQueue(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	job, err := e.store.Enqueue(ctx, domain.NewJob{Queue: "default", Type: "noop", MaxAttempts: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.Lease(ctx, "default", "w", 1, time.Minute); err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.Fail(ctx, job.ID, "w", "boom", t0); err != nil {
		t.Fatal(err)
	}
	alive, _ := e.store.Enqueue(ctx, domain.NewJob{Queue: "default", Type: "noop"})

	page := decode[pageBody](t, call(t, e.handler, http.MethodGet, "/v1/dead?queue=default", ""))
	if len(page.Jobs) != 1 || page.Jobs[0].ID != job.ID || page.Jobs[0].State != "dead" || *page.Jobs[0].LastError != "boom" {
		t.Fatalf("dead page = %+v", page)
	}

	path := fmt.Sprintf("/v1/dead/%d/requeue", job.ID)
	rec := call(t, e.handler, http.MethodPost, path, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("requeue: %d %s", rec.Code, rec.Body)
	}
	if got := decode[jobBody](t, rec); got.State != "available" || got.Attempts != 0 {
		t.Errorf("requeued job = %+v", got)
	}
	expectError(t, call(t, e.handler, http.MethodPost, path, ""), http.StatusConflict, "conflict")
	expectError(t, call(t, e.handler, http.MethodPost, fmt.Sprintf("/v1/dead/%d/requeue", alive.ID), ""), http.StatusConflict, "conflict")
	expectError(t, call(t, e.handler, http.MethodPost, "/v1/dead/999/requeue", ""), http.StatusNotFound, "not_found")
}
