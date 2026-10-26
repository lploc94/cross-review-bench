package builtin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/worker"
)

func job(payload string) domain.Job {
	return domain.Job{ID: 77, Queue: "default", Type: TypeHTTPPost, Payload: json.RawMessage(payload)}
}

func TestHTTPPostDeliversBody(t *testing.T) {
	var got struct {
		method, contentType, idempotency, custom string
		body                                     string
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.method, got.body = r.Method, string(b)
		got.contentType = r.Header.Get("Content-Type")
		got.idempotency = r.Header.Get("Idempotency-Key")
		got.custom = r.Header.Get("X-Signature")
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	err := HTTPPost(srv.Client())(context.Background(), job(`{"url":"`+srv.URL+`/hook","body":{"event":"paid"},"headers":{"X-Signature":"abc","Content-Type":"text/plain"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got.method != http.MethodPost || got.body != `{"event":"paid"}` || got.contentType != "application/json" ||
		got.idempotency != "jobqueue-77" || got.custom != "abc" {
		t.Errorf("request = %+v", got)
	}
}

func TestHTTPPostClassifiesResponses(t *testing.T) {
	cases := []struct {
		status    int
		permanent bool
	}{
		{http.StatusBadRequest, true},
		{http.StatusNotFound, true},
		{http.StatusRequestTimeout, false},
		{http.StatusTooManyRequests, false},
		{http.StatusInternalServerError, false},
		{http.StatusBadGateway, false},
	}
	for _, tc := range cases {
		t.Run(http.StatusText(tc.status), func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.Error(w, "upstream says no", tc.status)
			}))
			defer srv.Close()
			err := HTTPPost(srv.Client())(context.Background(), job(`{"url":"`+srv.URL+`"}`))
			if err == nil {
				t.Fatal("non-2xx response accepted")
			}
			if domain.IsPermanent(err) != tc.permanent {
				t.Errorf("permanent = %v, want %v (%v)", domain.IsPermanent(err), tc.permanent, err)
			}
			if !strings.Contains(err.Error(), "upstream says no") {
				t.Errorf("error lacks the response body: %v", err)
			}
		})
	}
}

func TestHTTPPostRejectsBadPayloads(t *testing.T) {
	for _, p := range []string{`{"url":"ftp://example.com"}`, `{"url":"/relative"}`, `{"url":""}`, `{"url":5}`} {
		err := HTTPPost(http.DefaultClient)(context.Background(), job(p))
		if !domain.IsPermanent(err) {
			t.Errorf("%s: error = %v, want a permanent error", p, err)
		}
	}
}

func TestHTTPPostTransportErrorIsRetried(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close() // nothing listens any more
	err := HTTPPost(http.DefaultClient)(context.Background(), job(`{"url":"`+url+`"}`))
	if err == nil || domain.IsPermanent(err) {
		t.Errorf("error = %v, want a retryable error", err)
	}
}

func TestSleep(t *testing.T) {
	clk := clock.NewManual(time.Date(2025, time.March, 10, 9, 0, 0, 0, time.UTC))
	handler := Sleep(clk, time.Minute)
	done := make(chan error, 1)
	go func() {
		done <- handler(context.Background(), domain.Job{Payload: json.RawMessage(`{"duration":"30s"}`)})
	}()
	clk.BlockUntil(1)
	clk.Advance(30 * time.Second)
	if err := <-done; err != nil {
		t.Errorf("sleep = %v", err)
	}
}

func TestSleepExtendsLeaseWhenLongerThanInterval(t *testing.T) {
	clk := clock.NewManual(time.Date(2025, time.March, 10, 9, 0, 0, 0, time.UTC))
	handler := Sleep(clk, time.Minute)
	done := make(chan error, 1)
	// Outside a worker the context carries no lease, so the first extension fails.
	go func() {
		done <- handler(context.Background(), domain.Job{Payload: json.RawMessage(`{"duration":"90s"}`)})
	}()
	clk.BlockUntil(1)
	clk.Advance(time.Minute)
	if err := <-done; !errors.Is(err, worker.ErrNoLease) {
		t.Errorf("error = %v, want the extension to be attempted", err)
	}
}

func TestSleepRejectsBadDuration(t *testing.T) {
	handler := Sleep(clock.Real{}, time.Minute)
	for _, p := range []string{`{"duration":"forever"}`, `{"duration":"-1s"}`, `{"duration":"2h"}`, `[]`} {
		if err := handler(context.Background(), domain.Job{Payload: json.RawMessage(p)}); !domain.IsPermanent(err) {
			t.Errorf("%s: error = %v, want permanent", p, err)
		}
	}
}

func TestRegister(t *testing.T) {
	reg := worker.NewRegistry(time.Second)
	Register(reg, Options{LeaseDuration: time.Minute})
	if got := strings.Join(reg.Types(), ","); got != "http.post,noop,sleep" {
		t.Errorf("registered types = %s", got)
	}
}
