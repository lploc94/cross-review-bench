package model

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"strings"
	"time"
)

// MaxConsumerNameLength bounds consumer names.
const MaxConsumerNameLength = 64

var consumerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// Consumer is a client of the gateway: an application or a team that holds API keys or HMAC
// secrets. A disabled consumer keeps its credentials, but none of them authenticates.
type Consumer struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// ConsumerInput is what an operator sets when creating a consumer.
type ConsumerInput struct {
	Name    string
	Enabled bool
}

// ConsumerPatch changes some fields of a consumer; nil fields are left as they are.
type ConsumerPatch struct {
	Name    *string
	Enabled *bool
}

// Empty reports whether the patch changes nothing.
func (p ConsumerPatch) Empty() bool { return p.Name == nil && p.Enabled == nil }

// ValidateConsumerName checks a consumer name: 1 to MaxConsumerNameLength letters, digits,
// dots, dashes and underscores, starting with a letter or digit.
func ValidateConsumerName(name string) error {
	switch {
	case name == "":
		return Invalid("name", "is required")
	case len(name) > MaxConsumerNameLength:
		return Invalid("name", "must be at most %d characters", MaxConsumerNameLength)
	case !consumerNamePattern.MatchString(name):
		return Invalid("name", "may contain only letters, digits, '.', '-' and '_', and must start with a letter or digit")
	}
	return nil
}

// Validate checks the input.
func (in ConsumerInput) Validate() error {
	return ValidateConsumerName(in.Name)
}

// Validate checks the fields the patch sets.
func (p ConsumerPatch) Validate() error {
	if p.Empty() {
		return Invalid("body", "must set name or enabled")
	}
	if p.Name != nil {
		return ValidateConsumerName(*p.Name)
	}
	return nil
}

// NewConsumerID returns a random consumer id such as "c_3f9a0c2b7d14e6a8".
func NewConsumerID() string {
	return "c_" + randomHex(8)
}

// ValidConsumerID reports whether id has the shape NewConsumerID produces. Lookups reject other
// ids before they reach the store.
func ValidConsumerID(id string) bool {
	rest, ok := strings.CutPrefix(id, "c_")
	return ok && isLowerHex(rest, 16)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b) // crypto/rand.Read never returns an error
	return hex.EncodeToString(b)
}

func isLowerHex(s string, n int) bool {
	if len(s) != n {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return false
		}
	}
	return true
}
