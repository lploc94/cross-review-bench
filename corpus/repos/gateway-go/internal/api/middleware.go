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

	"github.com/relaywork/gateway/internal/metrics"
)

// errUnauthorized is reported for a missing or wrong admin token.
var errUnauthorized = errors.New("missing or invalid admin token")

// authenticator checks bearer tokens against the admin token. Both sides are hashed before the
// constant-time comparison, so neither the token's contents nor its length leak through timing.
type authenticator struct {
	want [sha256.Size]byte
}

func newAuthenticator(token string) *authenticator {
	return &authenticator{want: sha256.Sum256([]byte(token))}
}

func (a *authenticator) allow(r *http.Request) bool {
	values := r.Header.Values("Authorization")
	if len(values) != 1 {
		return false
	}
	token, ok := bearerToken(values[0])
	if !ok {
		return false
	}
	got := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(got[:], a.want[:]) == 1
}

// bearerToken extracts the token from an "Authorization: Bearer <token>" header value.
func bearerToken(value string) (string, bool) {
	scheme, token, ok := strings.Cut(value, " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", false
	}
	token = strings.TrimSpace(token)
	return token, token != ""
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.auth.allow(r) {
			w.Header().Set("WWW-Authenticate", `Bearer realm="gateway-admin"`)
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
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		defer func() {
			v := recover()
			if v == nil {
				return
			}
			if v == http.ErrAbortHandler {
				panic(v)
			}
			s.log.Error("admin handler panicked", "panic", v, "stack", string(debug.Stack()),
				"method", r.Method, "path", r.URL.Path, "request_id", requestID(r.Context()))
			if rec.wroteHeader {
				return // too late for an error response
			}
			s.writeError(rec, r, errors.New("handler panicked"))
		}()
		next.ServeHTTP(rec, r)
	})
}

type requestIDKey struct{}

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// withRequestID takes the request id from X-Request-ID when it is well formed, generates one
// otherwise, and echoes it in the response.
func (s *Server) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if !requestIDPattern.MatchString(id) {
			var b [16]byte
			_, _ = rand.Read(b[:]) // crypto/rand.Read never returns an error
			id = hex.EncodeToString(b[:])
		}
		w.Header().Set("X-Request-ID", id)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey{}, id)))
	})
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
func (s *Server) instrument(pattern string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := s.clock.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		elapsed := s.clock.Now().Sub(start)

		s.httpm.requests.Inc(pattern, strconv.Itoa(rec.status))
		s.httpm.duration.Observe(elapsed.Seconds(), pattern)
		s.log.Info("admin request",
			"method", r.Method,
			"path", r.URL.Path,
			"pattern", pattern,
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
		requests: reg.NewCounter("gateway_admin_requests_total", "Admin API requests by route pattern and status code.", "pattern", "status"),
		duration: reg.NewHistogram("gateway_admin_request_duration_seconds", "Admin API latency by route pattern.", nil, "pattern"),
	}
}
