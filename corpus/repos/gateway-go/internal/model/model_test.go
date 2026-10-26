package model

import (
	"errors"
	"strings"
	"testing"
)

func TestAPIKeyRoundTrip(t *testing.T) {
	key, prefix, hash := NewAPIKey()
	if len(key) != MaxAPIKeyLength || !strings.HasPrefix(key, "gk_"+prefix+".") {
		t.Fatalf("key %q does not have the documented shape", key)
	}
	got, ok := ParseAPIKey(key)
	if !ok || got != prefix || !ValidKeyPrefix(prefix) {
		t.Fatalf("ParseAPIKey = %q, %v; want %q", got, ok, prefix)
	}
	if HashAPIKey(key) != hash {
		t.Error("hash differs from HashAPIKey")
	}
	other, _, _ := NewAPIKey()
	if other == key {
		t.Error("two keys are equal")
	}
}

func TestParseAPIKeyRejectsMalformedKeys(t *testing.T) {
	key, _, _ := NewAPIKey()
	for _, bad := range []string{
		"",
		key[:len(key)-1],
		key + "A",
		"xx_" + key[3:],
		strings.Replace(key, ".", "_", 1),
		"gk_ABCDEF012345." + key[16:], // upper-case prefix
		key[:16] + strings.Repeat("!", len(key)-16),
	} {
		if _, ok := ParseAPIKey(bad); ok {
			t.Errorf("ParseAPIKey(%q) accepted a malformed key", bad)
		}
	}
}

func TestHMACCredentialShape(t *testing.T) {
	id, secret := NewHMACCredential()
	if !ValidHMACKeyID(id) || len(secret) != 43 {
		t.Errorf("id %q secret length %d", id, len(secret))
	}
	for _, bad := range []string{"hk_123", "hk_0123456789ABCDEF", "xx_0123456789abcdef", ""} {
		if ValidHMACKeyID(bad) {
			t.Errorf("ValidHMACKeyID(%q) = true", bad)
		}
	}
}

func TestConsumerValidation(t *testing.T) {
	valid := []string{"billing", "Billing-Service_2", "a", "x.y", strings.Repeat("a", MaxConsumerNameLength)}
	for _, n := range valid {
		if err := ValidateConsumerName(n); err != nil {
			t.Errorf("ValidateConsumerName(%q) = %v", n, err)
		}
	}
	invalid := []string{"", "-lead", "has space", "ünï", strings.Repeat("a", MaxConsumerNameLength+1)}
	for _, n := range invalid {
		err := ValidateConsumerName(n)
		var ve *ValidationError
		if !errors.As(err, &ve) || ve.Fields[0].Field != "name" {
			t.Errorf("ValidateConsumerName(%q) = %v, want a ValidationError on name", n, err)
		}
	}
	if err := (ConsumerPatch{}).Validate(); err == nil {
		t.Error("an empty patch validated")
	}
	enabled := false
	if err := (ConsumerPatch{Enabled: &enabled}).Validate(); err != nil {
		t.Errorf("patch with only enabled: %v", err)
	}
}

func TestConsumerIDs(t *testing.T) {
	id := NewConsumerID()
	if !ValidConsumerID(id) {
		t.Errorf("ValidConsumerID(%q) = false", id)
	}
	for _, bad := range []string{"c_", "c_xyz", "C_0123456789abcdef", "0123456789abcdef", "c_0123456789abcdef0"} {
		if ValidConsumerID(bad) {
			t.Errorf("ValidConsumerID(%q) = true", bad)
		}
	}
}

func TestValidationErrorListsEveryField(t *testing.T) {
	v := &ValidationError{}
	if v.Err() != nil {
		t.Fatal("empty ValidationError is an error")
	}
	v.Add("name", "is required")
	v.Add("limit", "must be at most %d", 500)
	if got := v.Err().Error(); got != "invalid input: name: is required; limit: must be at most 500" {
		t.Errorf("Error() = %q", got)
	}
}
