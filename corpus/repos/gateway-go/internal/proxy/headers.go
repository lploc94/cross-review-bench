package proxy

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"strings"

	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/header"
)

var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// requestID returns the client's X-Request-ID when it is well formed, and a new random id
// otherwise.
func requestID(r *http.Request) string {
	if values := r.Header.Values(header.RequestID); len(values) == 1 && requestIDPattern.MatchString(values[0]) {
		return values[0]
	}
	var b [16]byte
	_, _ = rand.Read(b[:]) // crypto/rand.Read never returns an error
	return hex.EncodeToString(b[:])
}

// trustedProxies decides whose forwarding headers to believe.
type trustedProxies []netip.Prefix

func (t trustedProxies) contains(a netip.Addr) bool {
	for _, p := range t {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// remoteAddr returns the address of the peer that sent the request.
func remoteAddr(r *http.Request) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap(), true
}

// clientInfo is what the gateway believes about the request's origin.
type clientInfo struct {
	peer    string   // the direct peer's address, "" when unknown
	trusted bool     // whether the peer is a trusted proxy
	chain   []string // the X-Forwarded-For chain to send upstream, peer last
	ip      string   // the original client: the first untrusted address from the right
	proto   string
	host    string
}

// resolveClient works out the client and the forwarding headers. X-Forwarded-For from a trusted
// proxy is extended with the proxy's address; from anyone else it is replaced by the peer's
// address, so that clients cannot plant addresses in it. Likewise X-Forwarded-Proto and
// X-Forwarded-Host are only passed on from trusted proxies.
func (t trustedProxies) resolveClient(r *http.Request) clientInfo {
	ci := clientInfo{proto: "http", host: r.Host}
	if r.TLS != nil {
		ci.proto = "https"
	}
	peer, ok := remoteAddr(r)
	if !ok {
		ci.ip = r.RemoteAddr
		return ci
	}
	ci.peer = peer.String()
	ci.ip = ci.peer
	ci.trusted = t.contains(peer)
	if !ci.trusted {
		ci.chain = []string{ci.peer}
		return ci
	}

	var prior []string
	for _, line := range r.Header.Values(header.ForwardedFor) {
		for _, hop := range strings.Split(line, ",") {
			if hop = strings.TrimSpace(hop); hop != "" {
				prior = append(prior, hop)
			}
		}
	}
	ci.chain = append(prior, ci.peer)
	// Walk from the peer towards the client while the hops are trusted proxies. The first
	// address no trusted proxy vouches for is the client.
	for i := len(prior) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(prior[i])
		if err != nil {
			break // garbage from beyond the trusted hops; the last trusted hop is what we know
		}
		a = a.Unmap()
		ci.ip = a.String()
		if !t.contains(a) {
			break
		}
	}
	if v := firstValue(r.Header.Get(header.ForwardedProto)); v == "http" || v == "https" {
		ci.proto = v
	}
	if v := firstValue(r.Header.Get(header.ForwardedHost)); v != "" {
		ci.host = v
	}
	return ci
}

// firstValue returns the first element of a comma-separated header value, lower-cased for
// protocol names and trimmed.
func firstValue(v string) string {
	v, _, _ = strings.Cut(v, ",")
	return strings.ToLower(strings.TrimSpace(v))
}

// dropUnforwarded removes from h the client fields the gateway never forwards, as header or as
// trailer: hop-by-hop fields and the ones the client's Connection header (connection) lists, the
// credentials the gateway consumed (strip), fields the gateway sets itself, Forwarded, and, from
// peers that are not trusted proxies, X-Real-Ip and X-Forwarded-Port. Then the renames and
// removals of the route's request transform apply.
func dropUnforwarded(h http.Header, connection []string, route *core.Route, strip []string, ci clientInfo) {
	header.RemoveListed(h, connection)
	header.RemoveHopByHop(h)
	for _, name := range strip {
		h.Del(name)
	}
	h.Del(header.ConsumerID)
	h.Del(header.RequestID)
	// The standard Forwarded field would let a client plant addresses the X-Forwarded-*
	// handling exists to keep out; the gateway sends only the X-Forwarded-* fields.
	h.Del("Forwarded")
	h.Del(header.ForwardedFor)
	h.Del(header.ForwardedProto)
	h.Del(header.ForwardedHost)
	if !ci.trusted {
		h.Del(header.RealIP)
		h.Del(header.ForwardedPort)
	}
	// net/http writes Trailer from the outbound request's trailer map.
	h.Del("Trailer")
	route.Request.Filter(h)
}

// outboundHeader builds the header of a request to an upstream from the client's header: the
// fields dropUnforwarded names are removed, the route's request transform adds its fields, and
// the gateway's own fields are set.
func outboundHeader(in http.Header, route *core.Route, strip []string, ci clientInfo, reqID, consumerID string) http.Header {
	h := in.Clone()
	if h == nil {
		h = make(http.Header)
	}
	dropUnforwarded(h, in.Values("Connection"), route, strip, ci)
	route.Request.AddTo(h)

	h.Set(header.RequestID, reqID)
	if len(ci.chain) > 0 {
		h.Set(header.ForwardedFor, strings.Join(ci.chain, ", "))
	}
	h.Set(header.ForwardedProto, ci.proto)
	if ci.host != "" {
		h.Set(header.ForwardedHost, ci.host)
	}
	if consumerID != "" {
		h.Set(header.ConsumerID, consumerID)
	}
	// Without a User-Agent the HTTP client would send its own; an empty value sends none.
	if _, ok := h["User-Agent"]; !ok {
		h["User-Agent"] = []string{""}
	}
	return h
}

// forwardedTrailer filters the client's request trailers with the rules of outboundHeader:
// what dropUnforwarded removes, and fields the route's request transform adds to the header.
// Framing fields (Host, Content-Length, Trailer), which a trailer may not carry, go too.
func forwardedTrailer(trailer, in http.Header, route *core.Route, strip []string, ci clientInfo) http.Header {
	t := trailer.Clone()
	dropUnforwarded(t, in.Values("Connection"), route, strip, ci)
	header.RemoveFraming(t)
	for name := range t {
		if route.Request.Adds(name) {
			delete(t, name)
		}
	}
	return t
}

// outboundTrailer returns the trailer of a request to an upstream and a wrapper for the body
// that carries it, or nil when no trailer field passes forwardedTrailer. The trailer lists the
// passing field names from the start, since they are announced before the body; the wrapper
// fills in their values when the client's body has been read to the end, as net/http only knows
// them then.
func outboundTrailer(r *http.Request, route *core.Route, strip []string, ci clientInfo) (http.Header, func(io.ReadCloser) io.ReadCloser) {
	if len(r.Trailer) == 0 {
		return nil, nil
	}
	names := make(http.Header, len(r.Trailer))
	for name := range r.Trailer {
		names[name] = nil
	}
	out := forwardedTrailer(names, r.Header, route, strip, ci)
	if len(out) == 0 {
		return nil, nil
	}
	fill := func() {
		values := forwardedTrailer(r.Trailer, r.Header, route, strip, ci)
		for name := range out {
			out[name] = values[name]
		}
	}
	wrap := func(body io.ReadCloser) io.ReadCloser {
		return &trailerFiller{ReadCloser: body, fill: fill}
	}
	return out, wrap
}

// trailerFiller calls fill once its body reports EOF.
type trailerFiller struct {
	io.ReadCloser
	fill func()
	done bool
}

func (b *trailerFiller) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if errors.Is(err, io.EOF) && !b.done {
		b.done = true
		b.fill()
	}
	return n, err
}

// relayable removes from h, an upstream response's header or trailer, the fields the gateway
// does not relay: hop-by-hop fields and the ones the response's Connection header (connection)
// lists, Trailer, which net/http writes itself, and what the route's response transform removes
// or renames away.
func relayable(h http.Header, connection []string, route *core.Route) {
	header.RemoveListed(h, connection)
	header.RemoveHopByHop(h)
	h.Del("Trailer")
	route.Response.Filter(h)
}

// copyResponseHeader copies an upstream response's header to the client's, with the fields
// relayable removes left out and the route's response transform applied. Trailers are relayed by
// respond.
func copyResponseHeader(dst, src http.Header, route *core.Route) {
	h := src.Clone()
	relayable(h, src.Values("Connection"), route)
	route.Response.AddTo(h)
	for name, values := range h {
		dst[name] = values
	}
}

// relayedTrailer filters an upstream response's trailer with the rules of copyResponseHeader:
// what relayable removes, fields the response transform adds to the header, and fields the
// gateway sets in the response itself (gateway). Framing fields, which a trailer may not
// carry, go too.
func relayedTrailer(trailer, respHeader, gateway http.Header, route *core.Route) http.Header {
	t := trailer.Clone()
	relayable(t, respHeader.Values("Connection"), route)
	header.RemoveFraming(t)
	for name := range t {
		if _, set := gateway[name]; set || route.Response.Adds(name) {
			delete(t, name)
		}
	}
	return t
}
