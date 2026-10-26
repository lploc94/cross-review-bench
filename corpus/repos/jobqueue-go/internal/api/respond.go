package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"

	"github.com/relaywork/jobqueue/internal/domain"
)

// maxBodyBytes bounds request bodies: a job payload plus its envelope.
const maxBodyBytes = domain.MaxPayloadBytes + 16<<10

// errorBody is the JSON shape of every error response.
type errorBody struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code      string              `json:"code"`
	Message   string              `json:"message"`
	Fields    []domain.FieldError `json:"fields,omitempty"`
	RequestID string              `json:"request_id,omitempty"`
}

// badRequestError is a request the server could not parse at all, as opposed to one that
// parsed but did not validate.
type badRequestError struct {
	msg    string
	status int
	cause  error
}

func (e *badRequestError) Error() string { return e.msg }

func (e *badRequestError) Unwrap() error { return e.cause }

func badRequest(format string, args ...any) error {
	return &badRequestError{msg: fmt.Sprintf(format, args...), status: http.StatusBadRequest}
}

// writeError maps err to a status code and writes it as JSON. Errors the client cannot act on
// are logged and reported as a generic 500.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	detail := errorDetail{RequestID: requestID(r.Context())}
	var (
		status int
		verr   *domain.ValidationError
		berr   *badRequestError
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
	case errors.Is(err, errUnauthorized):
		status, detail.Code, detail.Message = http.StatusUnauthorized, "unauthorized", err.Error()
	case errors.Is(err, domain.ErrNotFound):
		status, detail.Code, detail.Message = http.StatusNotFound, "not_found", err.Error()
	case errors.Is(err, domain.ErrConflict):
		status, detail.Code, detail.Message = http.StatusConflict, "conflict", err.Error()
	default:
		s.log.Error("request failed", "method", r.Method, "path", r.URL.Path, "error", err,
			"request_id", detail.RequestID)
		status, detail.Code, detail.Message = http.StatusInternalServerError, "internal", "internal server error"
	}
	s.writeJSON(w, status, errorBody{Error: detail})
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
	w.WriteHeader(status)
	_, _ = w.Write(append(body, '\n'))
}

// errEmptyBody is the cause of the error decodeJSON returns for a body with no JSON value. A
// handler whose body is optional accepts it.
var errEmptyBody = errors.New("request body is empty")

// decodeJSON reads a single JSON value from the request body into v, rejecting other content
// types, unknown fields, trailing data and bodies over maxBodyBytes.
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) error {
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
		return decodeError(err)
	}
	// Only whitespace may follow the value: a second value, a stray delimiter or a read error
	// all fail the request.
	var extra struct{}
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
		return &badRequestError{msg: errEmptyBody.Error(), status: http.StatusBadRequest, cause: errEmptyBody}
	default:
		return badRequest("malformed JSON: %s", err)
	}
}

// pathID parses the {id} path value.
func pathID(r *http.Request) (int64, error) {
	raw := r.PathValue("id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		return 0, domain.Invalid("id", "must be a positive integer, got %q", raw)
	}
	return id, nil
}

// pageParams parses the after and limit query parameters shared by the list endpoints.
func pageParams(r *http.Request, v *domain.ValidationError) (after int64, limit int) {
	q := r.URL.Query()
	if raw := q.Get("after"); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			v.Add("after", "must be a non-negative integer")
		}
		after = n
	}
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			v.Add("limit", "must be a positive integer")
		}
		limit = n
	}
	return after, limit
}
