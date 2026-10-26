package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeAPI answers jobctl's requests from a table of "METHOD /path" to status and body.
type fakeAPI struct {
	mu       sync.Mutex
	routes   map[string][]response // consumed in order; the last one repeats
	requests []string
}

type response struct {
	status int
	body   string
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	key := r.Method + " " + r.URL.Path
	body, _ := io.ReadAll(r.Body)
	f.requests = append(f.requests, strings.TrimSpace(key+"?"+r.URL.RawQuery+" "+string(body)))
	resps, ok := f.routes[key]
	if !ok {
		http.Error(w, `{"error":{"code":"not_found","message":"no route"}}`, http.StatusNotFound)
		return
	}
	resp := resps[0]
	if len(resps) > 1 {
		f.routes[key] = resps[1:]
	}
	w.WriteHeader(resp.status)
	_, _ = io.WriteString(w, resp.body)
}

func runCLI(t *testing.T, api *fakeAPI, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	srv := httptest.NewServer(api)
	defer srv.Close()
	vars := map[string]string{"JOBQUEUE_URL": srv.URL, "JOBQUEUE_TOKEN": "secret"}
	var out, errOut strings.Builder
	code = run(context.Background(), args, func(k string) string { return vars[k] }, &out, &errOut)
	return code, out.String(), errOut.String()
}

func jobJSON(id int, state string) string {
	return fmt.Sprintf(`{"id":%d,"queue":"default","type":"noop","state":"%s","attempts":1,"max_attempts":5,"run_at":"2025-03-10T09:00:00Z"}`, id, state)
}

func TestEnqueueCommand(t *testing.T) {
	api := &fakeAPI{routes: map[string][]response{"POST /v1/queues/emails/jobs": {{201, jobJSON(1, "available")}}}}
	code, out, errOut := runCLI(t, api, "enqueue", "-queue", "emails", "-type", "email.send", "-payload", `{"to":"x"}`, "-priority", "3")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	if !strings.Contains(out, `"id": 1`) {
		t.Errorf("stdout = %s", out)
	}
	if got := api.requests[0]; got != `POST /v1/queues/emails/jobs? {"type":"email.send","payload":{"to":"x"},"priority":3}` {
		t.Errorf("request = %s", got)
	}
}

func TestListCommandPrintsTable(t *testing.T) {
	page := `{"jobs":[` + jobJSON(1, "dead") + `],"next_after":1}`
	api := &fakeAPI{routes: map[string][]response{"GET /v1/jobs": {{200, page}}}}
	code, out, errOut := runCLI(t, api, "list", "-state", "dead", "-limit", "1")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "ID") || !strings.Contains(lines[1], "dead") || lines[2] != "more: -after 1" {
		t.Errorf("stdout:\n%s", out)
	}
	if api.requests[0] != "GET /v1/jobs?limit=1&state=dead" {
		t.Errorf("request = %s", api.requests[0])
	}
}

func TestRequeueReportsEachFailure(t *testing.T) {
	api := &fakeAPI{routes: map[string][]response{
		"POST /v1/dead/1/requeue": {{200, jobJSON(1, "available")}},
		"POST /v1/dead/2/requeue": {{409, `{"error":{"code":"conflict","message":"job 2 is running"}}`}},
	}}
	code, out, errOut := runCLI(t, api, "requeue", "1", "2", "3")
	if code != 1 {
		t.Errorf("exit = %d, want 1", code)
	}
	if !strings.Contains(out, "requeued job 1") {
		t.Errorf("stdout = %s", out)
	}
	if !strings.Contains(errOut, "job 2: 409 conflict") || !strings.Contains(errOut, "job 3: 404 not_found") {
		t.Errorf("stderr = %s", errOut)
	}
}

func TestWaitCommand(t *testing.T) {
	api := &fakeAPI{routes: map[string][]response{
		"GET /v1/jobs/4": {{200, jobJSON(4, "running")}, {200, jobJSON(4, "succeeded")}},
		"GET /v1/jobs/5": {{200, jobJSON(5, "dead")}},
	}}
	if code, _, errOut := runCLI(t, api, "wait", "-interval", "1ms", "4"); code != 0 {
		t.Errorf("wait for a job that succeeds: exit %d: %s", code, errOut)
	}
	code, out, errOut := runCLI(t, api, "wait", "5")
	if code != 1 || !strings.Contains(errOut, "job 5 is dead") || !strings.Contains(out, `"state": "dead"`) {
		t.Errorf("wait for a dead job: exit %d\nstdout %s\nstderr %s", code, out, errOut)
	}
}

func TestScheduleCommands(t *testing.T) {
	sc := `{"name":"nightly","spec":"0 3 * * *","queue":"default","type":"noop","enabled":true,"next_run_at":"2025-03-11T03:00:00Z"}`
	api := &fakeAPI{routes: map[string][]response{
		"PUT /v1/schedules/nightly":    {{201, sc}},
		"GET /v1/schedules/nightly":    {{200, sc}},
		"GET /v1/schedules":            {{200, `{"schedules":[` + sc + `]}`}},
		"DELETE /v1/schedules/nightly": {{204, ""}},
	}}
	if code, _, errOut := runCLI(t, api, "schedule-put", "-spec", "0 3 * * *", "-type", "noop", "-disabled", "nightly"); code != 0 {
		t.Fatalf("schedule-put: exit %d: %s", code, errOut)
	}
	if got := api.requests[0]; got != `PUT /v1/schedules/nightly? {"spec":"0 3 * * *","queue":"default","type":"noop","enabled":false}` {
		t.Errorf("request = %s", got)
	}
	if code, out, _ := runCLI(t, api, "schedule", "nightly"); code != 0 || !strings.Contains(out, `"spec": "0 3 * * *"`) {
		t.Errorf("schedule: exit %d: %s", code, out)
	}
	if code, out, _ := runCLI(t, api, "schedules"); code != 0 || !strings.Contains(out, "nightly") || !strings.Contains(out, "2025-03-11T03:00:00Z") {
		t.Errorf("schedules: exit %d:\n%s", code, out)
	}
	if code, out, _ := runCLI(t, api, "schedule-delete", "nightly"); code != 0 || out != "deleted schedule nightly\n" {
		t.Errorf("schedule-delete: exit %d: %q", code, out)
	}
}

func TestUsageErrors(t *testing.T) {
	cases := [][]string{
		{},
		{"frobnicate"},
		{"get"},
		{"get", "abc"},
		{"cancel", "1", "2"},
		{"enqueue"},
		{"list", "-bogus"},
		{"schedule-put", "name"},
		{"wait", "-interval", "0s", "1"},
	}
	for _, args := range cases {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			api := &fakeAPI{}
			code, _, errOut := runCLI(t, api, args...)
			if code != 2 || errOut == "" {
				t.Errorf("exit %d, stderr %q; want 2 with a message", code, errOut)
			}
			if len(api.requests) != 0 {
				t.Errorf("sent %v for a usage error", api.requests)
			}
		})
	}
}

func TestMissingToken(t *testing.T) {
	var errOut strings.Builder
	code := run(context.Background(), []string{"list"}, func(string) string { return "" }, io.Discard, &errOut)
	if code != 2 || !strings.Contains(errOut.String(), "JOBQUEUE_TOKEN") {
		t.Errorf("exit %d: %s", code, errOut.String())
	}
}

func TestOneLine(t *testing.T) {
	if got := oneLine("a\n  b\tc", 10); got != "a b c" {
		t.Errorf("oneLine = %q", got)
	}
	if got := oneLine(strings.Repeat("é", 20), 5); got != "éééé…" {
		t.Errorf("oneLine = %q", got)
	}
}
