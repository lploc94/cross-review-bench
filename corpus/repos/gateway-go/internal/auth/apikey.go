package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/header"
	"github.com/relaywork/gateway/internal/model"
)

// APIKeyAuthenticator accepts a key issued by the admin API, sent as "Authorization: Bearer
// <key>" or "X-API-Key: <key>".
type APIKeyAuthenticator struct {
	Store  CredentialStore
	Clock  clock.Clock
	Logger *slog.Logger
}

// NeedsBody reports false: API keys do not cover the body.
func (a *APIKeyAuthenticator) NeedsBody() bool { return false }

// StripHeaders lists Authorization and X-API-Key.
func (a *APIKeyAuthenticator) StripHeaders() []string {
	return []string{"Authorization", header.APIKey}
}

// Authenticate looks the key up by its prefix and compares its hash with the stored one in
// constant time.
func (a *APIKeyAuthenticator) Authenticate(ctx context.Context, r *http.Request, _ []byte) (model.Consumer, error) {
	key, err := presentedKey(r)
	if err != nil {
		return model.Consumer{}, err
	}
	prefix, ok := model.ParseAPIKey(key)
	if !ok {
		return model.Consumer{}, invalid("malformed API key")
	}
	rec, err := a.Store.APIKey(ctx, prefix)
	switch {
	case errors.Is(err, model.ErrNotFound):
		return model.Consumer{}, invalid("unknown API key prefix %s", prefix)
	case err != nil:
		return model.Consumer{}, err
	}
	got := model.HashAPIKey(key)
	if subtle.ConstantTimeCompare(got[:], rec.Hash[:]) != 1 {
		return model.Consumer{}, invalid("API key %s does not match", prefix)
	}
	if !rec.Active() {
		return model.Consumer{}, invalid("API key %s is revoked", prefix)
	}
	c, err := enabledConsumer(ctx, a.Store, rec.ConsumerID)
	if err != nil {
		return model.Consumer{}, err
	}
	if rec.LastUsedAt == nil || a.Clock.Now().Sub(*rec.LastUsedAt) >= model.TouchInterval {
		// Bookkeeping only: a failure must not fail the request.
		if err := a.Store.TouchAPIKey(ctx, prefix); err != nil {
			a.Logger.Warn("record API key use", "key_prefix", prefix, "error", err)
		}
	}
	return c, nil
}

// presentedKey returns the key from the Authorization or X-API-Key header. Sending both, or
// either one twice, is an error rather than a guess.
func presentedKey(r *http.Request) (string, error) {
	authz := r.Header.Values("Authorization")
	apiKey := r.Header.Values(header.APIKey)
	switch {
	case len(authz) == 0 && len(apiKey) == 0:
		return "", ErrMissingCredentials
	case len(authz)+len(apiKey) > 1:
		return "", invalid("more than one credential header")
	case len(apiKey) == 1:
		key := strings.TrimSpace(apiKey[0])
		if key == "" {
			return "", ErrMissingCredentials
		}
		return key, nil
	}
	scheme, token, ok := strings.Cut(authz[0], " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return "", invalid("Authorization scheme must be Bearer")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", ErrMissingCredentials
	}
	return token, nil
}
