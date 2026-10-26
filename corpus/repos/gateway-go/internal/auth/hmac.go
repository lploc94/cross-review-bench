package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/model"
)

// HMACScheme is the Authorization scheme of signed requests:
//
//	Authorization: HMAC key_id=hk_0123456789abcdef, signature=<hex>, timestamp=<unix seconds>
const HMACScheme = "HMAC"

// HMACAuthenticator verifies requests signed with a consumer's HMAC secret. The signature is the
// lower-case hex HMAC-SHA256, keyed with the secret's text, of the canonical string (see
// CanonicalString).
type HMACAuthenticator struct {
	Store CredentialStore
	Clock clock.Clock
	// MaxSkew is how far the signature's timestamp may be from the gateway's clock, either way.
	// Within it, a captured request can be replayed; keep it short.
	MaxSkew time.Duration
}

// NeedsBody reports true: the signature covers the body's SHA-256.
func (a *HMACAuthenticator) NeedsBody() bool { return true }

// StripHeaders lists Authorization.
func (a *HMACAuthenticator) StripHeaders() []string { return []string{"Authorization"} }

// Authenticate checks the timestamp, finds the credential by key id and compares signatures in
// constant time.
func (a *HMACAuthenticator) Authenticate(ctx context.Context, r *http.Request, body []byte) (model.Consumer, error) {
	values := r.Header.Values("Authorization")
	switch {
	case len(values) == 0:
		return model.Consumer{}, ErrMissingCredentials
	case len(values) > 1:
		return model.Consumer{}, invalid("more than one Authorization header")
	}
	params, err := ParseHMACAuthorization(values[0])
	if err != nil {
		return model.Consumer{}, err
	}

	signed := time.Unix(params.Timestamp, 0)
	if skew := a.Clock.Now().Sub(signed); skew > a.MaxSkew || skew < -a.MaxSkew {
		return model.Consumer{}, ErrStaleSignature
	}

	cred, err := a.Store.HMACCredential(ctx, params.KeyID)
	switch {
	case errors.Is(err, model.ErrNotFound):
		return model.Consumer{}, invalid("unknown HMAC key id %s", params.KeyID)
	case err != nil:
		return model.Consumer{}, err
	}

	canonical, err := CanonicalString(r.Method, SigningPath(r.URL), r.URL.RawQuery, params.Timestamp, body)
	if err != nil {
		return model.Consumer{}, err
	}
	want := sign(cred.Secret, canonical)
	if !hmac.Equal(params.Signature, want) {
		return model.Consumer{}, invalid("signature does not match for HMAC key id %s", params.KeyID)
	}
	if !cred.Active() {
		return model.Consumer{}, invalid("HMAC key id %s is revoked", params.KeyID)
	}
	return enabledConsumer(ctx, a.Store, cred.ConsumerID)
}

// HMACParams are the parameters of an HMAC Authorization header.
type HMACParams struct {
	KeyID     string
	Signature []byte // decoded from hex
	Timestamp int64  // Unix seconds
}

// ParseHMACAuthorization parses "HMAC key_id=…, signature=…, timestamp=…". Parameters may come
// in any order and their values may be quoted; each must appear exactly once.
func ParseHMACAuthorization(value string) (HMACParams, error) {
	scheme, rest, ok := strings.Cut(strings.TrimSpace(value), " ")
	if !ok || !strings.EqualFold(scheme, HMACScheme) {
		return HMACParams{}, invalid("Authorization scheme must be %s", HMACScheme)
	}
	var p HMACParams
	seen := make(map[string]bool)
	for _, part := range strings.Split(rest, ",") {
		name, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return HMACParams{}, invalid("malformed HMAC parameter")
		}
		name = strings.ToLower(strings.TrimSpace(name))
		v = strings.TrimSpace(v)
		if len(v) >= 2 && v[0] == '"' && v[len(v)-1] == '"' {
			v = v[1 : len(v)-1]
		}
		if seen[name] {
			return HMACParams{}, invalid("HMAC parameter %s given twice", name)
		}
		seen[name] = true
		switch name {
		case "key_id":
			if !model.ValidHMACKeyID(v) {
				return HMACParams{}, invalid("malformed HMAC key id")
			}
			p.KeyID = v
		case "signature":
			sig, err := hex.DecodeString(v)
			if err != nil || len(sig) != sha256.Size {
				return HMACParams{}, invalid("signature must be %d hex digits", 2*sha256.Size)
			}
			p.Signature = sig
		case "timestamp":
			ts, err := strconv.ParseInt(v, 10, 64)
			if err != nil || ts <= 0 {
				return HMACParams{}, invalid("timestamp must be a positive number of Unix seconds")
			}
			p.Timestamp = ts
		default:
			return HMACParams{}, invalid("unknown HMAC parameter %s", name)
		}
	}
	if !seen["key_id"] || !seen["signature"] || !seen["timestamp"] {
		return HMACParams{}, invalid("HMAC Authorization needs key_id, signature and timestamp")
	}
	return p, nil
}

// SigningPath returns the path of u as the client sent it in the request line. net/url keeps
// that form in RawPath when it differs from the default escaping; EscapedPath would escape some
// characters ("{", "}", "|") that clients may send as they are. RawPath counts only while it
// still decodes to Path, so that a signature never covers a path other than the one served.
func SigningPath(u *url.URL) string {
	if u.RawPath != "" {
		if p, err := url.PathUnescape(u.RawPath); err == nil && p == u.Path {
			return u.RawPath
		}
	}
	return u.EscapedPath()
}

// CanonicalString builds the string a request signature covers, five lines joined by "\n":
//
//	the method exactly as sent (methods are case-sensitive)
//	the path exactly as sent in the request line (escaped; see SigningPath)
//	the canonical query: parameters sorted by name, then by value, each name and value
//	  percent-encoded (RFC 3986; space as %20), joined as name=value with "&"
//	the timestamp in Unix seconds
//	the lower-case hex SHA-256 of the body (of the empty string when there is none)
//
// A query that cannot be parsed cannot be signed.
func CanonicalString(method, escapedPath, rawQuery string, timestamp int64, body []byte) (string, error) {
	query, err := canonicalQuery(rawQuery)
	if err != nil {
		return "", err
	}
	bodyHash := sha256.Sum256(body)
	return strings.Join([]string{
		method,
		escapedPath,
		query,
		strconv.FormatInt(timestamp, 10),
		hex.EncodeToString(bodyHash[:]),
	}, "\n"), nil
}

func canonicalQuery(rawQuery string) (string, error) {
	if rawQuery == "" {
		return "", nil
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil {
		return "", invalid("query string cannot be parsed: %v", err)
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	slices.Sort(names)
	var b strings.Builder
	for _, name := range names {
		vs := slices.Clone(values[name])
		slices.Sort(vs)
		for _, v := range vs {
			if b.Len() > 0 {
				b.WriteByte('&')
			}
			b.WriteString(escape(name))
			b.WriteByte('=')
			b.WriteString(escape(v))
		}
	}
	return b.String(), nil
}

// escape percent-encodes s as RFC 3986 requires for a query component: everything but
// unreserved characters, with space as %20.
func escape(s string) string {
	return strings.ReplaceAll(url.QueryEscape(s), "+", "%20")
}

func sign(secret, canonical string) []byte {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write([]byte(canonical))
	return m.Sum(nil)
}

// Sign returns the hex signature of a request, as a client computes it.
func Sign(secret, method, escapedPath, rawQuery string, timestamp int64, body []byte) (string, error) {
	canonical, err := CanonicalString(method, escapedPath, rawQuery, timestamp, body)
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(sign(secret, canonical)), nil
}

// AuthorizationHeader formats the Authorization value of a signed request.
func AuthorizationHeader(keyID, signature string, timestamp int64) string {
	return HMACScheme + " key_id=" + keyID + ", signature=" + signature + ", timestamp=" + strconv.FormatInt(timestamp, 10)
}
