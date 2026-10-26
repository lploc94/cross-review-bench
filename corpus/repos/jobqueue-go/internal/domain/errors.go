package domain

import (
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrNotFound reports that the requested job or schedule does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict reports that the operation does not apply to the resource in its current state,
	// for example cancelling a job that is already running.
	ErrConflict = errors.New("conflict")
	// ErrLeaseLost reports that a worker tried to settle or extend a job it no longer holds: the
	// lease expired and the job was reaped, or another worker leased it since.
	ErrLeaseLost = errors.New("lease lost")
)

// FieldError describes one invalid input field.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// ValidationError reports input that failed validation. It lists every problem found, not only
// the first one.
type ValidationError struct {
	Fields []FieldError
}

func (e *ValidationError) Error() string {
	parts := make([]string, len(e.Fields))
	for i, f := range e.Fields {
		parts[i] = f.Field + ": " + f.Message
	}
	return "invalid input: " + strings.Join(parts, "; ")
}

// Add records a problem with field.
func (e *ValidationError) Add(field, format string, args ...any) {
	e.Fields = append(e.Fields, FieldError{Field: field, Message: fmt.Sprintf(format, args...)})
}

// Err returns e when it holds at least one problem, and nil otherwise.
func (e *ValidationError) Err() error {
	if len(e.Fields) == 0 {
		return nil
	}
	return e
}

// Invalid returns a ValidationError for a single field.
func Invalid(field, format string, args ...any) error {
	v := &ValidationError{}
	v.Add(field, format, args...)
	return v
}

// PermanentError marks a handler failure that retrying cannot fix, such as a malformed payload.
// The job is moved to the failed state instead of being retried.
type PermanentError struct {
	Err error
}

func (e *PermanentError) Error() string { return e.Err.Error() }
func (e *PermanentError) Unwrap() error { return e.Err }

// Permanent wraps err so that the worker does not retry the job. It returns nil for a nil err.
func Permanent(err error) error {
	if err == nil {
		return nil
	}
	return &PermanentError{Err: err}
}

// IsPermanent reports whether err, or an error it wraps, is a PermanentError.
func IsPermanent(err error) bool {
	var p *PermanentError
	return errors.As(err, &p)
}
