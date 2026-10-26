package api_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/store"
)

type scheduleBody struct {
	Name      string         `json:"name"`
	Spec      string         `json:"spec"`
	Queue     string         `json:"queue"`
	Type      string         `json:"type"`
	Payload   map[string]any `json:"payload"`
	Enabled   bool           `json:"enabled"`
	NextRunAt time.Time      `json:"next_run_at"`
	LastRunAt *time.Time     `json:"last_run_at"`
}

func storeAll() store.ListFilter { return store.ListFilter{Limit: store.MaxPageSize} }

func TestScheduleLifecycle(t *testing.T) {
	e := newEnv(t)
	body := `{"spec":"30 6 * * MON-FRI","queue":"reports","type":"report.build","payload":{"kind":"daily"}}`

	rec := call(t, e.handler, http.MethodPut, "/v1/schedules/daily-report", body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", rec.Code, rec.Body)
	}
	sc := decode[scheduleBody](t, rec)
	// t0 is Monday 09:00 UTC, past today's 06:30 run.
	if want := time.Date(2025, time.March, 11, 6, 30, 0, 0, time.UTC); !sc.NextRunAt.Equal(want) {
		t.Errorf("next_run_at = %s, want %s", sc.NextRunAt, want)
	}
	if !sc.Enabled || sc.Payload["kind"] != "daily" || sc.LastRunAt != nil {
		t.Errorf("schedule = %+v", sc)
	}

	rec = call(t, e.handler, http.MethodPut, "/v1/schedules/daily-report",
		`{"spec":"30 6 * * MON-FRI","queue":"reports","type":"report.build","enabled":false}`)
	if rec.Code != http.StatusOK || decode[scheduleBody](t, rec).Enabled {
		t.Errorf("replace: %d %s", rec.Code, rec.Body)
	}

	rec = call(t, e.handler, http.MethodGet, "/v1/schedules/daily-report", "")
	if rec.Code != http.StatusOK || decode[scheduleBody](t, rec).Spec != "30 6 * * MON-FRI" {
		t.Errorf("get: %d %s", rec.Code, rec.Body)
	}
	call(t, e.handler, http.MethodPut, "/v1/schedules/another", `{"spec":"@hourly","queue":"default","type":"noop"}`)
	list := decode[struct {
		Schedules []scheduleBody `json:"schedules"`
	}](t, call(t, e.handler, http.MethodGet, "/v1/schedules", ""))
	if len(list.Schedules) != 2 || list.Schedules[0].Name != "another" {
		t.Errorf("list = %+v", list)
	}

	rec = call(t, e.handler, http.MethodDelete, "/v1/schedules/daily-report", "")
	if rec.Code != http.StatusNoContent || rec.Body.Len() != 0 {
		t.Errorf("delete: %d %q", rec.Code, rec.Body)
	}
	expectError(t, call(t, e.handler, http.MethodGet, "/v1/schedules/daily-report", ""), http.StatusNotFound, "not_found")
	expectError(t, call(t, e.handler, http.MethodDelete, "/v1/schedules/daily-report", ""), http.StatusNotFound, "not_found")
}

func TestPutScheduleValidation(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		name, path, body string
		fields           string
	}{
		{"bad spec", "/v1/schedules/s", `{"spec":"61 * * * *","queue":"default","type":"noop"}`, "spec"},
		{"never fires", "/v1/schedules/s", `{"spec":"0 0 30 2 *","queue":"default","type":"noop"}`, "spec"},
		{"bad name", "/v1/schedules/Has%20Space", `{"spec":"@daily","queue":"default","type":"noop"}`, "name"},
		{"everything", "/v1/schedules/s", `{"spec":"","queue":"","type":"","payload":"x"}`, "spec,queue,type,payload"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := expectError(t, call(t, e.handler, http.MethodPut, tc.path, tc.body), http.StatusUnprocessableEntity, "validation_failed")
			if got := strings.Join(fieldNames(resp), ","); got != tc.fields {
				t.Errorf("fields = %s, want %s", got, tc.fields)
			}
		})
	}
}
