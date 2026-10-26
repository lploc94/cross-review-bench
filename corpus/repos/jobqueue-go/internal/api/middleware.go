package api

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/relaywork/jobqueue/internal/metrics"
)

// errUnauthorized is reported for a missing or wrong bearer token.
var errUnauthorized = errors.New("missing or invalid bearer token")

// authenticator checks bearer tokens against the admin token. Both sides are hashed before the
// constant-time comparison, so neither the token's contents nor its length leak through timing.
type authenticator struct {
	want [sha256.Size]byte
}

func newAuthenticator(token string) *authenticator {
	return &authenticator{want: sha256.Sum256([]byte(token))}
}

func (a *authenticator) allow(r *http.Request) bool {
	token, ok := bearerToken(r.Header.Get("Authorization"))
	if !ok {
		return false
	}
	got := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(got[:], a.want[:]) == 1
}

// bearerToken extracts the token from an "Authorization: Bearer <token>" header value.
func bearerToken(header string) (string, bool) {
	scheme, token, ok := strings.Cut(header, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.auth.allow(r) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="jobqueue"`)
			s.writeError(w, r, errUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// recoverPanics turns a panicking handler into a 500 response. http.ErrAbortHandler is passed
// on, since it is the documented way to abort a response.
func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			s.log.Error("handler panicked", "panic", v, "stack", string(debug.Stack()),
				"method", r.Method, "path", r.URL.Path, "request_id", requestID(r.Context()))
			if rec, ok := w.(*statusRecorder); ok && rec.wroteHeader {
				return // too late for an error response
			}
			s.writeError(w, r, errors.New("handler panicked"))
		}()
		next.ServeHTTP(w, r)
	})
}

type requestIDKey struct{}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// withRequestID takes the request id from X-Request-ID when it is well formed, generates one
// otherwise, and echoes it in the response.
func (s *Server) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !requestIDPattern.MatchString(id) {
			id = newRequestID()
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
}

func newRequestID() string {
	var b [8]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never returns an error
	return hex.EncodeToString(b[:])
}

func requestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}

// statusRecorder remembers the status code and body size of a response.
type statusRecorder struct {
	http.ResponseWriter
	status      int
	bytes       int
	wroteHeader bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHeader {
		r.status = code
		r.wroteHeader = true
	}
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Write(b []byte) (int, error) {
	if !r.wroteHeader {
		r.WriteHeader(http.StatusOK)
	}
	n, err := r.ResponseWriter.Write(b)
	r.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach the underlying writer.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

// instrument logs each request and records its count and latency under the route pattern, so
// that metric labels stay bounded whatever paths clients send.
func (s *Server) instrument(route string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		elapsed := time.Since(start)

		status := strconv.Itoa(rec.status)
		s.httpm.requests.Inc(route, status)
		s.httpm.duration.Observe(elapsed.Seconds(), route)
		s.log.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"route", route,
			"status", rec.status,
			"bytes", rec.bytes,
			"duration", elapsed,
			"remote", r.RemoteAddr,
			"request_id", requestID(r.Context()),
		)
	})
}

type httpMetrics struct {
	requests *metrics.Counter
	duration *metrics.Histogram
}

func newHTTPMetrics(reg *metrics.Registry) httpMetrics {
	return httpMetrics{
		requests: reg.NewCounter("jobqueue_http_requests_total", "HTTP requests by route and status code.", "route", "status"),
		duration: reg.NewHistogram("jobqueue_http_request_duration_seconds", "HTTP request latency by route.", nil, "route"),
	}
}
