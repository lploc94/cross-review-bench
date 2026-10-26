// Package config reads the gateway's process settings from the environment and its route table
// from a JSON file, and validates both, so that a misconfigured gateway fails at startup (or
// keeps its current routes on reload) instead of misrouting traffic.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"
)

// minTokenLength is the shortest admin token accepted; shorter tokens are too easy to guess.
const minTokenLength = 32

// Redis is the Redis connection configuration, the only part gatewayctl's offline commands need.
type Redis struct {
	URL       string
	KeyPrefix string // prepended to every key the gateway writes
}

// Config is the complete process configuration. Routes live in RoutesFile and are loaded with
// LoadRoutes.
type Config struct {
	Redis      Redis
	RoutesFile string

	ProxyAddr       string
	AdminAddr       string
	AdminToken      string
	LogLevel        slog.Level
	ShutdownTimeout time.Duration // how long in-flight requests may take to finish on shutdown

	ReadHeaderTimeout time.Duration // how long a client may take to send request headers
	IdleTimeout       time.Duration // how long an idle keep-alive client connection stays open
	DialTimeout       time.Duration // how long connecting to an upstream may take
	MaxIdleConns      int           // idle upstream connections kept per upstream host

	// TrustedProxies are the networks whose X-Forwarded-For the gateway extends instead of
	// replacing. Empty means no client is trusted.
	TrustedProxies []netip.Prefix
	// BodyBufferLimit bounds the request bodies the gateway holds in memory: to retry a request,
	// and to verify an HMAC signature over the body.
	BodyBufferLimit int64
	// HMACClockSkew is how far a signature's timestamp may be from the gateway's clock.
	HMACClockSkew time.Duration
}

// Load reads the configuration from the process environment.
func Load() (Config, error) {
	return LoadFrom(os.LookupEnv)
}

// LoadFrom reads the configuration through lookup, which has the signature of os.LookupEnv.
// It reports every invalid or missing variable at once.
func LoadFrom(lookup func(string) (string, bool)) (Config, error) {
	r := reader{lookup: lookup}
	cfg := Config{
		Redis:      readRedis(&r),
		RoutesFile: r.required("ROUTES_FILE"),

		ProxyAddr:       r.string("PROXY_ADDR", ":8080"),
		AdminAddr:       r.string("ADMIN_ADDR", ":9090"),
		AdminToken:      r.required("ADMIN_TOKEN"),
		LogLevel:        r.level("LOG_LEVEL", slog.LevelInfo),
		ShutdownTimeout: r.duration("SHUTDOWN_TIMEOUT", 15*time.Second),

		ReadHeaderTimeout: r.duration("READ_HEADER_TIMEOUT", 10*time.Second),
		IdleTimeout:       r.duration("IDLE_TIMEOUT", 2*time.Minute),
		DialTimeout:       r.duration("UPSTREAM_DIAL_TIMEOUT", 5*time.Second),
		MaxIdleConns:      r.int("UPSTREAM_MAX_IDLE_CONNS", 64, 1, 10000),

		TrustedProxies:  r.prefixes("TRUSTED_PROXIES"),
		BodyBufferLimit: int64(r.int("BODY_BUFFER_LIMIT", 1<<20, 0, 64<<20)),
		HMACClockSkew:   r.duration("HMAC_CLOCK_SKEW", 5*time.Minute),
	}
	cfg.validate(&r)
	if len(r.errs) > 0 {
		return Config{}, fmt.Errorf("configuration: %w", errors.Join(r.errs...))
	}
	return cfg, nil
}

// LoadRedis reads only the Redis settings through lookup.
func LoadRedis(lookup func(string) (string, bool)) (Redis, error) {
	r := reader{lookup: lookup}
	rd := readRedis(&r)
	if len(r.errs) > 0 {
		return Redis{}, fmt.Errorf("configuration: %w", errors.Join(r.errs...))
	}
	return rd, nil
}

func readRedis(r *reader) Redis {
	return Redis{
		URL:       r.required("REDIS_URL"),
		KeyPrefix: r.string("REDIS_KEY_PREFIX", "gw:"),
	}
}

func (c Config) validate(r *reader) {
	if c.AdminToken != "" && len(c.AdminToken) < minTokenLength {
		r.fail("ADMIN_TOKEN", "must be at least %d characters", minTokenLength)
	}
	if c.ProxyAddr == c.AdminAddr {
		r.fail("ADMIN_ADDR", "must differ from PROXY_ADDR")
	}
	positive := []struct {
		name string
		d    time.Duration
	}{
		{"SHUTDOWN_TIMEOUT", c.ShutdownTimeout},
		{"READ_HEADER_TIMEOUT", c.ReadHeaderTimeout},
		{"IDLE_TIMEOUT", c.IdleTimeout},
		{"UPSTREAM_DIAL_TIMEOUT", c.DialTimeout},
		{"HMAC_CLOCK_SKEW", c.HMACClockSkew},
	}
	for _, p := range positive {
		if p.d <= 0 {
			r.fail(p.name, "must be positive")
		}
	}
	if c.HMACClockSkew > time.Hour {
		r.fail("HMAC_CLOCK_SKEW", "must be at most 1h")
	}
}

// reader collects values and the problems found while reading them.
type reader struct {
	lookup func(string) (string, bool)
	errs   []error
}

func (r *reader) fail(name, format string, args ...any) {
	r.errs = append(r.errs, fmt.Errorf("%s %s", name, fmt.Sprintf(format, args...)))
}

func (r *reader) get(name string) (string, bool) {
	v, ok := r.lookup(name)
	v = strings.TrimSpace(v)
	return v, ok && v != ""
}

func (r *reader) required(name string) string {
	v, ok := r.get(name)
	if !ok {
		r.fail(name, "is required")
	}
	return v
}

func (r *reader) string(name, def string) string {
	if v, ok := r.get(name); ok {
		return v
	}
	return def
}

func (r *reader) int(name string, def, lo, hi int) int {
	v, ok := r.get(name)
	if !ok {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		r.fail(name, "must be an integer, got %q", v)
		return def
	}
	if n < lo || n > hi {
		r.fail(name, "must be between %d and %d, got %d", lo, hi, n)
		return def
	}
	return n
}

func (r *reader) duration(name string, def time.Duration) time.Duration {
	v, ok := r.get(name)
	if !ok {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		r.fail(name, "must be a duration such as 30s or 5m, got %q", v)
		return def
	}
	return d
}

func (r *reader) level(name string, def slog.Level) slog.Level {
	v, ok := r.get(name)
	if !ok {
		return def
	}
	var l slog.Level
	if err := l.UnmarshalText([]byte(v)); err != nil {
		r.fail(name, "must be debug, info, warn or error, got %q", v)
		return def
	}
	return l
}

// prefixes reads a comma-separated list of CIDR prefixes or single addresses.
func (r *reader) prefixes(name string) []netip.Prefix {
	v, ok := r.get(name)
	if !ok {
		return nil
	}
	var out []netip.Prefix
	for _, item := range strings.Split(v, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		p, err := parsePrefix(item)
		if err != nil {
			r.fail(name, "has an invalid entry %q: must be an IP address or a CIDR prefix", item)
			continue
		}
		out = append(out, p)
	}
	return out
}

// parsePrefix accepts "10.0.0.0/8" or a single address such as "10.0.0.1", and returns the
// prefix in canonical (masked) form.
func parsePrefix(s string) (netip.Prefix, error) {
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, err
		}
		if p.Addr().Is4In6() {
			// Client addresses are compared in their unmapped form, so a mapped prefix would
			// never match.
			return netip.Prefix{}, errors.New("IPv4-mapped IPv6 prefixes are not supported")
		}
		return p.Masked(), nil
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, err
	}
	a = a.Unmap()
	return netip.PrefixFrom(a, a.BitLen()), nil
}
