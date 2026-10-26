// Package auth authenticates the consumers of proxied requests: by API key, or by an HMAC
// signature over the request. Each route names the mode it requires.
package auth

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/relaywork/gateway/internal/model"
)

var (
	// ErrMissingCredentials reports a request without the credentials its route requires.
	ErrMissingCredentials = errors.New("missing credentials")
	// ErrInvalidCredentials reports credentials that are malformed, unknown, revoked, belong
	// to a disabled consumer, or do not match. The wrapped detail is for logs, not clients.
	ErrInvalidCredentials = errors.New("invalid credentials")
	// ErrStaleSignature reports an HMAC signature whose timestamp is too far from the
	// gateway's clock.
	ErrStaleSignature = errors.New("signature timestamp is outside the allowed clock skew")
)

// invalid wraps ErrInvalidCredentials with a reason for the log.
func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidCredentials, fmt.Sprintf(format, args...))
}

// IsAuthError reports whether err is a verdict on the request's credentials, as opposed to a
// failure to check them (Redis unavailable, for example).
func IsAuthError(err error) bool {
	return errors.Is(err, ErrMissingCredentials) || errors.Is(err, ErrInvalidCredentials) ||
		errors.Is(err, ErrStaleSignature)
}

// Authenticator checks the credentials of a request.
type Authenticator interface {
	// Authenticate returns the consumer the request's credentials belong to. body is the
	// complete request body when NeedsBody reports true, and nil otherwise.
	Authenticate(ctx context.Context, r *http.Request, body []byte) (model.Consumer, error)
	// NeedsBody reports whether Authenticate needs the request body.
	NeedsBody() bool
	// StripHeaders lists the request headers that carry this mode's credentials. They are
	// not forwarded to the upstream.
	StripHeaders() []string
}

// CredentialStore is the part of the store authenticators read.
type CredentialStore interface {
	APIKey(ctx context.Context, prefix string) (model.APIKey, error)
	TouchAPIKey(ctx context.Context, prefix string) error
	HMACCredential(ctx context.Context, keyID string) (model.HMACCredential, error)
	GetConsumer(ctx context.Context, id string) (model.Consumer, error)
}

// enabledConsumer loads the consumer a credential belongs to and checks that it may
// authenticate.
func enabledConsumer(ctx context.Context, store CredentialStore, id string) (model.Consumer, error) {
	c, err := store.GetConsumer(ctx, id)
	switch {
	case errors.Is(err, model.ErrNotFound):
		return model.Consumer{}, invalid("consumer %s no longer exists", id)
	case err != nil:
		return model.Consumer{}, err
	case !c.Enabled:
		return model.Consumer{}, invalid("consumer %s is disabled", id)
	}
	return c, nil
}

// Modes maps each route auth mode other than "none" to its authenticator.
type Modes map[string]Authenticator
