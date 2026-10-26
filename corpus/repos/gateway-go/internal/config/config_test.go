package config

import (
	"log/slog"
	"net/netip"
	"strings"
	"testing"
	"time"
)

func lookupFrom(env map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := env[k]
		return v, ok
	}
}

func validEnv() map[string]string {
	return map[string]string{
		"REDIS_URL":   "redis://localhost:6379/0",
		"ROUTES_FILE": "/etc/gateway/routes.json",
		"ADMIN_TOKEN": strings.Repeat("a", 32),
	}
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := LoadFrom(lookupFrom(validEnv()))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ProxyAddr != ":8080" || cfg.AdminAddr != ":9090" || cfg.Redis.KeyPrefix != "gw:" {
		t.Errorf("addresses/prefix = %q %q %q", cfg.ProxyAddr, cfg.AdminAddr, cfg.Redis.KeyPrefix)
	}
	if cfg.BodyBufferLimit != 1<<20 || cfg.HMACClockSkew != 5*time.Minute || cfg.LogLevel != slog.LevelInfo {
		t.Errorf("defaults = %+v", cfg)
	}
	if len(cfg.TrustedProxies) != 0 {
		t.Errorf("TrustedProxies = %v, want none by default", cfg.TrustedProxies)
	}
}

func TestLoadReportsEveryProblem(t *testing.T) {
	env := map[string]string{
		"ADMIN_TOKEN":       "short",
		"LOG_LEVEL":         "loud",
		"SHUTDOWN_TIMEOUT":  "-1s",
		"BODY_BUFFER_LIMIT": "lots",
		"TRUSTED_PROXIES":   "10.0.0.0/8, not-an-ip",
		"PROXY_ADDR":        ":7000",
		"ADMIN_ADDR":        ":7000",
	}
	_, err := LoadFrom(lookupFrom(env))
	if err == nil {
		t.Fatal("LoadFrom accepted an invalid environment")
	}
	for _, want := range []string{
		"REDIS_URL is required", "ROUTES_FILE is required", "ADMIN_TOKEN must be at least 32",
		"LOG_LEVEL must be", "SHUTDOWN_TIMEOUT must be positive", "BODY_BUFFER_LIMIT must be an integer",
		`TRUSTED_PROXIES has an invalid entry "not-an-ip"`, "ADMIN_ADDR must differ from PROXY_ADDR",
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q:\n%v", want, err)
		}
	}
}

func TestTrustedProxies(t *testing.T) {
	env := validEnv()
	env["TRUSTED_PROXIES"] = "10.1.2.3/8, 192.168.0.7 ,2001:db8::/32"
	cfg, err := LoadFrom(lookupFrom(env))
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("10.0.0.0/8"),
		netip.MustParsePrefix("192.168.0.7/32"),
		netip.MustParsePrefix("2001:db8::/32"),
	}
	if len(cfg.TrustedProxies) != len(want) {
		t.Fatalf("TrustedProxies = %v", cfg.TrustedProxies)
	}
	for i := range want {
		if cfg.TrustedProxies[i] != want[i] {
			t.Errorf("TrustedProxies[%d] = %v, want %v (masked)", i, cfg.TrustedProxies[i], want[i])
		}
	}

	env["TRUSTED_PROXIES"] = "::ffff:10.0.0.0/104"
	if _, err := LoadFrom(lookupFrom(env)); err == nil {
		t.Error("an IPv4-mapped prefix was accepted; it could never match")
	}
}

func TestLoadRedisOnly(t *testing.T) {
	rd, err := LoadRedis(lookupFrom(map[string]string{"REDIS_URL": "redis://r:6379/2", "REDIS_KEY_PREFIX": "edge:"}))
	if err != nil {
		t.Fatal(err)
	}
	if rd.URL != "redis://r:6379/2" || rd.KeyPrefix != "edge:" {
		t.Errorf("Redis = %+v", rd)
	}
	if _, err := LoadRedis(lookupFrom(nil)); err == nil {
		t.Error("LoadRedis without REDIS_URL succeeded")
	}
}

func TestHMACClockSkewBounds(t *testing.T) {
	env := validEnv()
	env["HMAC_CLOCK_SKEW"] = "2h"
	if _, err := LoadFrom(lookupFrom(env)); err == nil || !strings.Contains(err.Error(), "HMAC_CLOCK_SKEW must be at most 1h") {
		t.Errorf("err = %v", err)
	}
}
