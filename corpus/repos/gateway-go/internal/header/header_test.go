package header

import (
	"net/http"
	"testing"
)

func TestRemoveHopByHop(t *testing.T) {
	h := http.Header{}
	h.Add("Connection", "keep-alive, X-Internal-Trace")
	h.Add("Connection", "x-second-line")
	h.Set("Keep-Alive", "timeout=5")
	h.Set("Te", "trailers")
	h.Set("Trailer", "Expires")
	h.Set("Transfer-Encoding", "chunked")
	h.Set("Upgrade", "websocket")
	h.Set("Proxy-Authorization", "Basic abc")
	h.Set("Proxy-Connection", "keep-alive")
	h.Set("X-Internal-Trace", "1")
	h.Set("X-Second-Line", "1")
	h.Set("Content-Type", "application/json")
	h.Set("Authorization", "Bearer kept")

	RemoveHopByHop(h)

	for _, gone := range []string{"Connection", "Keep-Alive", "Te", "Transfer-Encoding", "Upgrade",
		"Proxy-Authorization", "Proxy-Connection", "X-Internal-Trace", "X-Second-Line"} {
		if _, ok := h[gone]; ok {
			t.Errorf("%s survived", gone)
		}
	}
	if h.Get("Content-Type") != "application/json" || h.Get("Authorization") != "Bearer kept" {
		t.Errorf("end-to-end fields removed: %v", h)
	}
}

// TestTrailerIsEndToEnd checks that the Trailer field, which RFC 9110 does not list as
// hop-by-hop, survives; transforms still may not touch it, since net/http writes it from the
// message's trailer map.
func TestTrailerIsEndToEnd(t *testing.T) {
	h := http.Header{"Trailer": {"X-Checksum"}}
	RemoveHopByHop(h)
	if IsHopByHop("Trailer") || h.Get("Trailer") != "X-Checksum" {
		t.Errorf("Trailer treated as hop-by-hop: %v", h)
	}
	if !IsReserved("trailer") {
		t.Error("transforms may change Trailer")
	}
}

func TestRemoveHopByHopIgnoresEmptyConnectionTokens(t *testing.T) {
	h := http.Header{"Connection": {" , ,close"}, "Accept": {"*/*"}}
	RemoveHopByHop(h)
	if len(h) != 1 || h.Get("Accept") != "*/*" {
		t.Errorf("header = %v", h)
	}
}

func TestIsReserved(t *testing.T) {
	for name, want := range map[string]bool{
		"x-forwarded-for": true, "X-Request-Id": true, "x-consumer-id": true, "host": true,
		"content-length": true, "TE": true, "proxy-anything": true,
		"Authorization": false, "X-Api-Key": false, "Content-Type": false, "Server": false,
	} {
		if got := IsReserved(name); got != want {
			t.Errorf("IsReserved(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestValidNameAndValue(t *testing.T) {
	for name, want := range map[string]bool{"X-Ok": true, "a!#$%&'*+-.^_`|~9": true, "": false, "Sp ace": false, "Col:on": false, "Ü": false} {
		if got := ValidName(name); got != want {
			t.Errorf("ValidName(%q) = %v, want %v", name, got, want)
		}
	}
	for v, want := range map[string]bool{"": true, "a b\tc": true, " lead": false, "trail ": false, "cr\rlf": false, "nul\x00": false, "del\x7f": false} {
		if got := ValidValue(v); got != want {
			t.Errorf("ValidValue(%q) = %v, want %v", v, got, want)
		}
	}
}

func TestRemoveFraming(t *testing.T) {
	h := http.Header{"Host": {"evil.example"}, "Content-Length": {"99"}, "Trailer": {"X-A"}, "X-Sum": {"abc"}}
	RemoveFraming(h)
	if len(h) != 1 || h.Get("X-Sum") != "abc" {
		t.Errorf("after RemoveFraming: %v", h)
	}
}
