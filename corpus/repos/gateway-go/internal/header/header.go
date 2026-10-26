// Package header knows which HTTP header fields belong to a single connection and which ones the
// gateway owns, and checks header names and values from the routes file.
package header

import (
	"net/http"
	"net/textproto"
	"strings"
)

// Names of the headers the gateway reads or sets itself.
const (
	RequestID      = "X-Request-Id"
	ForwardedFor   = "X-Forwarded-For"
	ForwardedProto = "X-Forwarded-Proto"
	ForwardedHost  = "X-Forwarded-Host"
	ConsumerID     = "X-Consumer-Id"
	APIKey         = "X-Api-Key"
	// RealIP and ForwardedPort are not set by the gateway, but upstreams commonly read them as
	// the client's address and port, so only trusted proxies may send them.
	RealIP        = "X-Real-Ip"
	ForwardedPort = "X-Forwarded-Port"
)

// hopByHop are the header fields that describe one connection and are never forwarded: the
// ones RFC 9110 (sections 7.6.1, 7.8, 10.1.4) and RFC 9112 (section 6.1) define as such, plus
// the pre-standard Keep-Alive and every Proxy-* field. Trailer is not among them: it announces
// end-to-end trailer fields, and net/http writes it from the message's trailer map.
var hopByHop = map[string]bool{
	"Connection":        true,
	"Keep-Alive":        true,
	"Te":                true,
	"Transfer-Encoding": true,
	"Upgrade":           true,
}

// IsHopByHop reports whether the field called name is hop-by-hop whatever the Connection
// header says.
func IsHopByHop(name string) bool {
	name = textproto.CanonicalMIMEHeaderKey(name)
	return hopByHop[name] || strings.HasPrefix(name, "Proxy-")
}

// RemoveHopByHop deletes from h every hop-by-hop field: the standard ones and the ones the
// Connection header lists, in any of its lines.
func RemoveHopByHop(h http.Header) {
	RemoveListed(h, h.Values("Connection"))
	for name := range h {
		if IsHopByHop(name) {
			delete(h, name)
		}
	}
}

// gatewayOwned are request fields the gateway sets on every forwarded request. Route transforms
// may not touch them, so that a route cannot forge a client address or a consumer.
var gatewayOwned = map[string]bool{
	RequestID:      true,
	ForwardedFor:   true,
	ForwardedProto: true,
	ForwardedHost:  true,
	ConsumerID:     true,
}

// framing are fields that describe the message itself; the HTTP library sets them.
var framing = map[string]bool{
	"Host":           true,
	"Content-Length": true,
	"Trailer":        true,
}

// RemoveFraming deletes the framing fields from h. They may not appear in a trailer (RFC 9110
// section 6.5.1); a header keeps them, since the HTTP library reads and sets them there.
func RemoveFraming(h http.Header) {
	for name := range framing {
		delete(h, name)
	}
}

// IsReserved reports whether a route transform may not add, remove or rename the field called
// name: hop-by-hop fields, gateway-owned fields and message framing.
func IsReserved(name string) bool {
	name = textproto.CanonicalMIMEHeaderKey(name)
	return IsHopByHop(name) || gatewayOwned[name] || framing[name]
}

// ValidName reports whether name is a valid field name (an RFC 9110 token).
func ValidName(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		if !isTokenChar(name[i]) {
			return false
		}
	}
	return true
}

func isTokenChar(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("!#$%&'*+-.^_`|~", c) >= 0
}

// ValidValue reports whether v is a valid field value: visible characters, spaces and tabs,
// with no leading or trailing whitespace.
func ValidValue(v string) bool {
	if v != strings.Trim(v, " \t") {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		if c == '\t' {
			continue
		}
		if c < ' ' || c == 0x7f {
			return false
		}
	}
	return true
}

// RemoveListed deletes from h the fields that the Connection header lines in connection name.
// Trailers go through it with the Connection header of the message they end.
func RemoveListed(h http.Header, connection []string) {
	for _, line := range connection {
		for _, name := range strings.Split(line, ",") {
			if name = strings.TrimSpace(name); name != "" {
				h.Del(name)
			}
		}
	}
}
