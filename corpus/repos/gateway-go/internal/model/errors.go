// Package model holds the gateway's persistent domain types: consumers and their credentials,
// the rules they must satisfy, and the error values shared by the store and the admin API.
package model

import (
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrNotFound reports that the requested consumer, key or secret does not exist.
	ErrNotFound = errors.New("not found")
	// ErrConflict reports that the operation clashes with existing state, for example a consumer
	// name that is already taken or a key that is already revoked.
	ErrConflict = errors.New("conflict")
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
