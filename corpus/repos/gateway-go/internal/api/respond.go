package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/relaywork/gateway/internal/model"
)

// maxBodyBytes bounds admin request bodies; the largest is a consumer patch.
const maxBodyBytes = 16 << 10

var (
	errRouteNotFound    = errors.New("no such admin endpoint")
	errMethodNotAllowed = errors.New("method not allowed")
	errReloadDisabled   = errors.New("route reload is not enabled")
)

// errorBody is the JSON shape of every error response.
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code      string             `json:"code"`
	Message   string             `json:"message"`
	Fields    []model.FieldError `json:"fields,omitempty"`
	Details   []string           `json:"details,omitempty"`
	RequestID string             `json:"request_id,omitempty"`
}

// badRequestError is a request the server could not parse at all, as opposed to one that
// parsed but did not validate.
type badRequestError struct {
	msg    string
	status int
}

func (e *badRequestError) Error() string { return e.msg }

func badRequest(format string, args ...any) error {
	return &badRequestError{msg: fmt.Sprintf(format, args...), status: http.StatusBadRequest}
}

// reloadError is a routes file that failed to load; the live table was kept.
type reloadError struct {
	err error
}

func (e *reloadError) Error() string { return e.err.Error() }
func (e *reloadError) Unwrap() error { return e.err }

// writeError maps err to a status code and writes it as JSON. Errors the client cannot act on
// are logged and reported as a generic 500.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	detail := errorDetail{RequestID: requestID(r.Context())}
	var (
		status int
		verr   *model.ValidationError
		berr   *badRequestError
		rerr   *reloadError
	)
	switch {
	case errors.As(err, &verr):
		status, detail.Code, detail.Message, detail.Fields = http.StatusUnprocessableEntity, "validation_failed", "the request is invalid", verr.Fields
	case errors.As(err, &berr):
		status, detail.Code, detail.Message = berr.status, "bad_request", berr.msg
		switch berr.status {
		case http.StatusRequestEntityTooLarge:
			detail.Code = "too_large"
		case http.StatusUnsupportedMediaType:
			detail.Code = "unsupported_media_type"
		}
	case errors.As(err, &rerr):
		status, detail.Code, detail.Message = http.StatusUnprocessableEntity, "invalid_routes", "the routes file is invalid; the live routes were kept"
		detail.Details = reloadDetails(rerr.err)
	case errors.Is(err, errUnauthorized):
		status, detail.Code, detail.Message = http.StatusUnauthorized, "unauthorized", err.Error()
	case errors.Is(err, errRouteNotFound):
		status, detail.Code, detail.Message = http.StatusNotFound, "not_found", err.Error()
	case errors.Is(err, errMethodNotAllowed):
		status, detail.Code, detail.Message = http.StatusMethodNotAllowed, "method_not_allowed", err.Error()
	case errors.Is(err, errReloadDisabled):
		status, detail.Code, detail.Message = http.StatusNotImplemented, "not_implemented", err.Error()
	case errors.Is(err, model.ErrNotFound):
		status, detail.Code, detail.Message = http.StatusNotFound, "not_found", err.Error()
	case errors.Is(err, model.ErrConflict):
		status, detail.Code, detail.Message = http.StatusConflict, "conflict", err.Error()
	default:
		s.log.Error("admin request failed", "method", r.Method, "path", r.URL.Path, "error", err,
			"request_id", detail.RequestID)
		status, detail.Code, detail.Message = http.StatusInternalServerError, "internal", "internal server error"
	}
	s.writeJSON(w, status, errorBody{Error: detail})
}

// reloadDetails lists the individual problems of a routes file: the joined errors under the
// wrapping that names the file, or the error itself.
func reloadDetails(err error) []string {
	for e := err; e != nil; e = errors.Unwrap(e) {
		if joined, ok := e.(interface{ Unwrap() []error }); ok {
			var out []string
			for _, inner := range joined.Unwrap() {
				out = append(out, inner.Error())
			}
			return out
		}
	}
	return []string{err.Error()}
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, v any) {
	body, err := json.Marshal(v)
	if err != nil {
		s.log.Error("encode response", "error", err)
		http.Error(w, `{"error":{"code":"internal","message":"internal server error"}}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)+1))
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

// decodeJSON reads a single JSON object from the request body into v, rejecting other content
// types, unknown fields, trailing data and bodies over maxBodyBytes. An empty body is accepted
// when allowEmpty is set and leaves v untouched.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any, allowEmpty bool) error {
	if ct := r.Header.Get("Content-Type"); ct != "" {
		mediaType, _, err := mime.ParseMediaType(ct)
		if err != nil || mediaType != "application/json" {
			return &badRequestError{msg: "Content-Type must be application/json", status: http.StatusUnsupportedMediaType}
		}
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		if errors.Is(err, io.EOF) && allowEmpty {
			return nil
		}
		return decodeError(err)
	}
	// Only whitespace may follow the object.
	var extra json.RawMessage
	switch err := dec.Decode(&extra); {
	case errors.Is(err, io.EOF):
		return nil
	case err == nil:
		return badRequest("request body must contain a single JSON object")
	default:
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return decodeError(err)
		}
		return badRequest("request body must contain a single JSON object")
	}
}

// decodeError maps an error from reading the request body to its response.
func decodeError(err error) error {
	var tooLarge *http.MaxBytesError
	switch {
	case errors.As(err, &tooLarge):
		return &badRequestError{msg: fmt.Sprintf("request body exceeds %d bytes", tooLarge.Limit), status: http.StatusRequestEntityTooLarge}
	case errors.Is(err, io.EOF):
		return badRequest("request body is empty")
	default:
		return badRequest("malformed JSON: %s", err)
	}
}

// pageParams parses the offset and limit query parameters.
func pageParams(r *http.Request) (offset, limit int, err error) {
	v := &model.ValidationError{}
	q := r.URL.Query()
	if raw := q.Get("offset"); raw != "" {
		n, perr := strconv.Atoi(raw)
		if perr != nil || n < 0 {
			v.Add("offset", "must be a non-negative integer")
		}
		offset = n
	}
	limit = 100
	if raw := q.Get("limit"); raw != "" {
		n, perr := strconv.Atoi(raw)
		if perr != nil || n < 1 {
			v.Add("limit", "must be a positive integer")
		}
		limit = n
	}
	return offset, limit, v.Err()
}
