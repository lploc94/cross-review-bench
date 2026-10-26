package api_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
)

// TestSingleJSONValue covers what may follow the request object: whitespace only.
func TestSingleJSONValue(t *testing.T) {
	srv := newServer(t, stubStore{}, clock.NewManual(t0), nil)
	cases := []struct {
		name string
		body string
	}{
		{"stray closing bracket", `{"type":"noop"}]`},
		{"stray closing brace", `{"type":"noop"}}`},
		{"stray brace after a space", `{"type":"noop"} }`},
		{"second object", `{"type":"noop"}{}`},
		{"scalar after the object", `{"type":"noop"} 1`},
		{"garbage after the object", `{"type":"noop"}x`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := call(t, srv, http.MethodPost, "/v1/queues/default/jobs", tc.body)
			expectError(t, rec, http.StatusBadRequest, "bad_request")
		})
	}
}

// TestTrailingWhitespace accepts whitespace after the object, and a body that is only
// whitespace after the object is still bounded by the size limit.
func TestTrailingWhitespace(t *testing.T) {
	e := newEnv(t)
	if rec := call(t, e.handler, http.MethodPost, "/v1/queues/default/jobs", "{\"type\":\"noop\"} \n\t \n"); rec.Code != http.StatusCreated {
		t.Fatalf("trailing whitespace: %d %s", rec.Code, rec.Body)
	}

	srv := newServer(t, stubStore{}, clock.NewManual(t0), nil)
	body := `{"type":"noop"}` + strings.Repeat(" ", domain.MaxPayloadBytes+32<<10)
	expectError(t, call(t, srv, http.MethodPost, "/v1/queues/default/jobs", body), http.StatusRequestEntityTooLarge, "too_large")
}
