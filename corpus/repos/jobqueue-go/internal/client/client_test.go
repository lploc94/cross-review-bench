package client

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// recorded is what the test server saw of the last request.
type recorded struct {
	method, path, query, auth, contentType, body string
}

func newTestServer(t *testing.T, status int, response string) (*Client, *recorded) {
	t.Helper()
	rec := &recorded{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		*rec = recorded{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("Authorization"), r.Header.Get("Content-Type"), string(b)}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(srv.Close)
	c, err := New(srv.URL, "secret", srv.Client())
	if err != nil {
		t.Fatal(err)
	}
	return c, rec
}

func TestEnqueueSendsRequest(t *testing.T) {
	c, rec := newTestServer(t, http.StatusCreated, `{"id":9,"queue":"emails","type":"email.send","state":"available"}`)
	job, err := c.Enqueue(context.Background(), "emails", EnqueueRequest{Type: "email.send", Payload: json.RawMessage(`{"to":"a"}`), Priority: 2})
	if err != nil {
		t.Fatal(err)
	}
	if job.ID != 9 || job.State != "available" {
		t.Errorf("job = %+v", job)
	}
	if rec.method != http.MethodPost || rec.path != "/v1/queues/emails/jobs" || rec.auth != "Bearer secret" || rec.contentType != "application/json" {
		t.Errorf("request = %+v", rec)
	}
	if rec.body != `{"type":"email.send","payload":{"to":"a"},"priority":2}` {
		t.Errorf("body = %s", rec.body)
	}
}

func TestListJobsQuery(t *testing.T) {
	c, rec := newTestServer(t, http.StatusOK, `{"jobs":[{"id":3}],"next_after":3}`)
	page, err := c.ListJobs(context.Background(), ListOptions{Queue: "q", State: "dead", After: 2, Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Jobs) != 1 || page.NextAfter == nil || *page.NextAfter != 3 {
		t.Errorf("page = %+v", page)
	}
	if rec.path != "/v1/jobs" || rec.query != "after=2&limit=1&queue=q&state=dead" {
		t.Errorf("request = %s?%s", rec.path, rec.query)
	}

	if _, err := c.ListDead(context.Background(), ListOptions{State: "ignored"}); err != nil {
		t.Fatal(err)
	}
	if rec.path != "/v1/dead" || rec.query != "" {
		t.Errorf("dead request = %s?%s", rec.path, rec.query)
	}
}

func TestAPIErrorsAreDecoded(t *testing.T) {
	c, _ := newTestServer(t, http.StatusUnprocessableEntity,
		`{"error":{"code":"validation_failed","message":"the request is invalid","fields":[{"field":"type","message":"is required"}],"request_id":"r1"}}`)
	_, err := c.Enqueue(context.Background(), "q", EnqueueRequest{})
	var apiErr *APIError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error = %v, want an APIError", err)
	}
	if apiErr.Status != 422 || apiErr.Code != "validation_failed" || len(apiErr.Fields) != 1 || apiErr.RequestID != "r1" {
		t.Errorf("APIError = %+v", apiErr)
	}
	if got := apiErr.Error(); got != "422 validation_failed: the request is invalid; type: is required" {
		t.Errorf("Error() = %q", got)
	}
}

func TestNonJSONErrorResponse(t *testing.T) {
	c, _ := newTestServer(t, http.StatusBadGateway, "<html>bad gateway</html>")
	_, err := c.GetJob(context.Background(), 1)
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 502 || apiErr.Code != "unexpected_response" {
		t.Errorf("error = %v", err)
	}
}

func TestIsNotFound(t *testing.T) {
	c, rec := newTestServer(t, http.StatusNotFound, `{"error":{"code":"not_found","message":"job 1: not found"}}`)
	_, err := c.Requeue(context.Background(), 1)
	if !IsNotFound(err) {
		t.Errorf("IsNotFound(%v) = false", err)
	}
	if rec.method != http.MethodPost || rec.path != "/v1/dead/1/requeue" {
		t.Errorf("request = %+v", rec)
	}
	if IsNotFound(errors.New("other")) {
		t.Error("IsNotFound of a plain error")
	}
}

func TestSchedules(t *testing.T) {
	c, rec := newTestServer(t, http.StatusOK, `{"name":"nightly","spec":"@daily","enabled":true}`)
	off := false
	sc, err := c.PutSchedule(context.Background(), "nightly", ScheduleRequest{Spec: "@daily", Queue: "q", Type: "t", Enabled: &off})
	if err != nil || sc.Name != "nightly" {
		t.Fatalf("PutSchedule = %+v, %v", sc, err)
	}
	if rec.method != http.MethodPut || rec.path != "/v1/schedules/nightly" || rec.body != `{"spec":"@daily","queue":"q","type":"t","enabled":false}` {
		t.Errorf("request = %+v", rec)
	}
	if err := c.DeleteSchedule(context.Background(), "nightly"); err != nil || rec.method != http.MethodDelete {
		t.Errorf("DeleteSchedule: %v, %+v", err, rec)
	}
}

func TestNewValidatesArguments(t *testing.T) {
	for _, base := range []string{"", "localhost:8080", "ftp://host", "http://"} {
		if _, err := New(base, "t", nil); err == nil {
			t.Errorf("New(%q) succeeded", base)
		}
	}
	if _, err := New("http://localhost:8080", "", nil); err == nil {
		t.Error("New without a token succeeded")
	}
}
