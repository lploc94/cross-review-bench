package proxy

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// Gateway error codes. Every response the gateway produces itself, rather than relays from an
// upstream, carries one of them.
const (
	codeBadRequest          = "bad_request"
	codeRouteNotFound       = "route_not_found"
	codeMethodNotAllowed    = "method_not_allowed"
	codeMissingCreds        = "missing_credentials"
	codeInvalidCreds        = "invalid_credentials"
	codeStaleSignature      = "stale_signature"
	codeBodyTooLarge        = "body_too_large"
	codeRateLimited         = "rate_limited"
	codeAuthUnavailable     = "auth_unavailable"
	codeNoHealthyUpstream   = "no_healthy_upstream"
	codeCircuitOpen         = "circuit_open"
	codeUpstreamUnreachable = "upstream_unreachable"
	codeUpstreamTimeout     = "upstream_timeout"
)

// gatewayError is a response the gateway produces itself.
type gatewayError struct {
	status  int
	code    string
	message string
}

func (e *gatewayError) Error() string { return e.code + ": " + e.message }

func newError(status int, code, message string) *gatewayError {
	return &gatewayError{status: status, code: code, message: message}
}

type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}

// writeError writes e as the JSON error body shared by every gateway error:
// {"error":{"code":"…","message":"…","request_id":"…"}}.
func writeError(w http.ResponseWriter, e *gatewayError, requestID string) {
	body, _ := json.Marshal(errorBody{Error: errorDetail{Code: e.code, Message: e.message, RequestID: requestID}})
	body = append(body, '\n')
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Content-Length", strconv.Itoa(len(body)))
	h.Set("Cache-Control", "no-store")
	h.Del("Content-Encoding")
	w.WriteHeader(e.status)
	_, _ = w.Write(body)
}
