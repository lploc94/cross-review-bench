package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/api"
	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/internal/metrics"
	"github.com/relaywork/jobqueue/internal/store"
	"github.com/relaywork/jobqueue/internal/testdb"
)

const token = "test-token-0123456789abcdef0123456789"

var testPool *pgxpool.Pool

func TestMain(m *testing.M) { os.Exit(testdb.Run(m, &testPool)) }

var t0 = time.Date(2025, time.March, 10, 9, 0, 0, 0, time.UTC)

type env struct {
	handler http.Handler
	store   *store.Store
	clock   *clock.Manual
}

// newEnv serves the API from a real store in the test schema.
func newEnv(t *testing.T) *env {
	t.Helper()
	db := testdb.Require(t, testPool)
	clk := clock.NewManual(t0)
	st := store.New(db, clk)
	return &env{handler: newServer(t, st, clk, nil), store: st, clock: clk}
}

func newServer(t *testing.T, st api.Store, clk clock.Clock, reg *metrics.Registry) *api.Server {
	t.Helper()
	srv, err := api.New(api.Options{Store: st, AdminToken: token, Clock: clk, Logger: logging.Discard(), Metrics: reg})
	if err != nil {
		t.Fatal(err)
	}
	return srv
}

// call sends an authenticated request; headers given as "Name: value" replace the defaults.
func call(t *testing.T, h http.Handler, method, path, body string, headers ...string) *httptest.ResponseRecorder {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req := httptest.NewRequest(method, path, r)
	req.Header.Set("Authorization", "Bearer "+token)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for _, h := range headers {
		k, v, _ := strings.Cut(h, ": ")
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode[T any](t *testing.T, rec *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(rec.Body.Bytes(), &v); err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return v
}

type errorResponse struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id"`
		Fields    []struct {
			Field   string `json:"field"`
			Message string `json:"message"`
		} `json:"fields"`
	} `json:"error"`
}

func expectError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) errorResponse {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body %s", rec.Code, status, rec.Body)
	}
	e := decode[errorResponse](t, rec)
	if e.Error.Code != code {
		t.Fatalf("error code = %q, want %q; body %s", e.Error.Code, code, rec.Body)
	}
	if rec.Header().Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type = %q", rec.Header().Get("Content-Type"))
	}
	return e
}

func fieldNames(e errorResponse) []string {
	var out []string
	for _, f := range e.Error.Fields {
		out = append(out, f.Field)
	}
	return out
}

// stubStore lets tests that never reach the database run without one. Methods it does not
// override panic through the nil embedded interface.
type stubStore struct {
	api.Store
	pingErr error
	get     func(id int64) (domain.Job, error)
}

func (s stubStore) Ping(context.Context) error { return s.pingErr }

func (s stubStore) Get(_ context.Context, id int64) (domain.Job, error) { return s.get(id) }

func TestNewRequiresStoreAndToken(t *testing.T) {
	if _, err := api.New(api.Options{AdminToken: token}); err == nil {
		t.Error("New without a store succeeded")
	}
	if _, err := api.New(api.Options{Store: stubStore{}}); err == nil {
		t.Error("New without a token succeeded")
	}
}

func TestV1RoutesRequireTheToken(t *testing.T) {
	srv := newServer(t, stubStore{}, clock.NewManual(t0), nil)
	routes := []struct{ method, path string }{
		{http.MethodPost, "/v1/queues/default/jobs"},
		{http.MethodGet, "/v1/jobs"},
		{http.MethodGet, "/v1/jobs/1"},
		{http.MethodPost, "/v1/jobs/1/cancel"},
		{http.MethodGet, "/v1/dead"},
		{http.MethodPost, "/v1/dead/1/requeue"},
		{http.MethodGet, "/v1/schedules"},
		{http.MethodGet, "/v1/schedules/x"},
		{http.MethodPut, "/v1/schedules/x"},
		{http.MethodDelete, "/v1/schedules/x"},
	}
	credentials := map[string]string{
		"missing":      "",
		"wrong token":  "Bearer " + strings.Repeat("x", len(token)),
		"token prefix": "Bearer " + token[:10],
		"basic scheme": "Basic " + token,
		"empty bearer": "Bearer ",
	}
	for _, rt := range routes {
		for name, header := range credentials {
			t.Run(rt.method+" "+rt.path+" "+name, func(t *testing.T) {
				rec := call(t, srv, rt.method, rt.path, "", "Authorization: "+header)
				expectError(t, rec, http.StatusUnauthorized, "unauthorized")
				if !strings.HasPrefix(rec.Header().Get("WWW-Authenticate"), "Bearer") {
					t.Errorf("WWW-Authenticate = %q", rec.Header().Get("WWW-Authenticate"))
				}
			})
		}
	}
}

func TestBearerSchemeIsCaseInsensitive(t *testing.T) {
	srv := newServer(t, stubStore{get: func(id int64) (domain.Job, error) {
		return domain.Job{}, domain.ErrNotFound
	}}, clock.NewManual(t0), nil)
	rec := call(t, srv, http.MethodGet, "/v1/jobs/1", "", "Authorization: bearer "+token)
	expectError(t, rec, http.StatusNotFound, "not_found")
}

func TestHealthz(t *testing.T) {
	ok := newServer(t, stubStore{}, clock.NewManual(t0), nil)
	rec := call(t, ok, http.MethodGet, "/healthz", "", "Authorization: ")
	if rec.Code != http.StatusOK || decode[map[string]string](t, rec)["status"] != "ok" {
		t.Errorf("healthy: %d %s", rec.Code, rec.Body)
	}
	down := newServer(t, stubStore{pingErr: errors.New("connection refused")}, clock.NewManual(t0), nil)
	rec = call(t, down, http.MethodGet, "/healthz", "")
	if rec.Code != http.StatusServiceUnavailable || decode[map[string]string](t, rec)["status"] != "unavailable" {
		t.Errorf("unhealthy: %d %s", rec.Code, rec.Body)
	}
}

func TestMetricsEndpoint(t *testing.T) {
	reg := metrics.NewRegistry()
	srv := newServer(t, stubStore{}, clock.NewManual(t0), reg)
	call(t, srv, http.MethodGet, "/healthz", "")
	call(t, srv, http.MethodGet, "/v1/jobs", "", "Authorization: ")

	rec := call(t, srv, http.MethodGet, "/metrics", "", "Authorization: ")
	body := rec.Body.String()
	if rec.Code != http.StatusOK || rec.Header().Get("Content-Type") != metrics.ContentType {
		t.Fatalf("GET /metrics: %d %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	for _, want := range []string{
		`jobqueue_http_requests_total{route="GET /healthz",status="200"} 1`,
		`jobqueue_http_requests_total{route="GET /v1/jobs",status="401"} 1`,
		`jobqueue_http_request_duration_seconds_count{route="GET /healthz"} 1`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("metrics lack %s:\n%s", want, body)
		}
	}
}

func TestRequestID(t *testing.T) {
	srv := newServer(t, stubStore{}, clock.NewManual(t0), nil)
	rec := call(t, srv, http.MethodGet, "/healthz", "", "X-Request-ID: abc-123")
	if got := rec.Header().Get("X-Request-ID"); got != "abc-123" {
		t.Errorf("echoed request id = %q", got)
	}
	rec = call(t, srv, http.MethodGet, "/healthz", "", "X-Request-ID: has spaces and \"quotes\"")
	if got := rec.Header().Get("X-Request-ID"); len(got) != 16 {
		t.Errorf("malformed request id replaced by %q, want a generated one", got)
	}
	rec = call(t, srv, http.MethodGet, "/v1/jobs", "", "Authorization: ", "X-Request-ID: req-9")
	if e := decode[errorResponse](t, rec); e.Error.RequestID != "req-9" {
		t.Errorf("error body request_id = %q", e.Error.RequestID)
	}
}

func TestPanicInHandlerBecomesInternalError(t *testing.T) {
	srv := newServer(t, stubStore{get: func(int64) (domain.Job, error) { panic("nil map") }}, clock.NewManual(t0), nil)
	rec := call(t, srv, http.MethodGet, "/v1/jobs/1", "")
	e := expectError(t, rec, http.StatusInternalServerError, "internal")
	if strings.Contains(rec.Body.String(), "nil map") {
		t.Errorf("internal details leaked: %s", e.Error.Message)
	}
}

func TestStoreErrorsAreNotLeaked(t *testing.T) {
	srv := newServer(t, stubStore{get: func(int64) (domain.Job, error) {
		return domain.Job{}, errors.New("pq: password authentication failed for user jobs")
	}}, clock.NewManual(t0), nil)
	rec := call(t, srv, http.MethodGet, "/v1/jobs/1", "")
	expectError(t, rec, http.StatusInternalServerError, "internal")
	if strings.Contains(rec.Body.String(), "password") {
		t.Errorf("store error leaked: %s", rec.Body)
	}
}

func TestMalformedRequests(t *testing.T) {
	srv := newServer(t, stubStore{}, clock.NewManual(t0), nil)
	big := `{"type":"noop","payload":{"x":"` + strings.Repeat("a", domain.MaxPayloadBytes+20<<10) + `"}}`
	cases := []struct {
		name    string
		body    string
		headers []string
		status  int
		code    string
	}{
		{"broken JSON", `{"type":`, nil, http.StatusBadRequest, "bad_request"},
		{"unknown field", `{"type":"noop","colour":"red"}`, nil, http.StatusBadRequest, "bad_request"},
		{"trailing data", `{"type":"noop"} {"type":"noop"}`, nil, http.StatusBadRequest, "bad_request"},
		{"empty body", ``, nil, http.StatusBadRequest, "bad_request"},
		{"wrong type", `{"type":5}`, nil, http.StatusBadRequest, "bad_request"},
		{"form content type", `{"type":"noop"}`, []string{"Content-Type: application/x-www-form-urlencoded"}, http.StatusUnsupportedMediaType, "unsupported_media_type"},
		{"too large", big, nil, http.StatusRequestEntityTooLarge, "too_large"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := call(t, srv, http.MethodPost, "/v1/queues/default/jobs", tc.body, tc.headers...)
			expectError(t, rec, tc.status, tc.code)
		})
	}
}

func TestInvalidParameters(t *testing.T) {
	srv := newServer(t, stubStore{}, clock.NewManual(t0), nil)
	cases := []struct {
		method, path string
		fields       []string
	}{
		{http.MethodGet, "/v1/jobs/abc", []string{"id"}},
		{http.MethodGet, "/v1/jobs/0", []string{"id"}},
		{http.MethodPost, "/v1/jobs/-4/cancel", []string{"id"}},
		{http.MethodPost, "/v1/dead/x/requeue", []string{"id"}},
		{http.MethodGet, "/v1/jobs?state=paused", []string{"state"}},
		{http.MethodGet, "/v1/jobs?queue=Bad%20Queue&limit=0&after=-1", []string{"queue", "after", "limit"}},
		{http.MethodGet, "/v1/dead?limit=ten", []string{"limit"}},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			e := expectError(t, call(t, srv, tc.method, tc.path, ""), http.StatusUnprocessableEntity, "validation_failed")
			if got := fieldNames(e); strings.Join(got, ",") != strings.Join(tc.fields, ",") {
				t.Errorf("fields = %v, want %v", got, tc.fields)
			}
		})
	}
}
