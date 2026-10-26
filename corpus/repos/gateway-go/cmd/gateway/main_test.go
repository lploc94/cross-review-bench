package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/logging"
)

func TestCheckRoutes(t *testing.T) {
	dir := t.TempDir()
	good := filepath.Join(dir, "good.json")
	bad := filepath.Join(dir, "bad.json")
	os.WriteFile(good, []byte(`{"routes":[{"id":"a","path":"/a","upstreams":[{"url":"http://a.internal"}]}]}`), 0o600)
	os.WriteFile(bad, []byte(`{"routes":[{"id":"a","path":"/a","timeout":"-1s","upstreams":[]}]}`), 0o600)

	var out, errOut strings.Builder
	if code := checkRoutes(good, &out, &errOut); code != 0 || !strings.Contains(out.String(), "1 routes OK") {
		t.Errorf("good file: code %d, %q", code, out.String())
	}
	out.Reset()
	if code := checkRoutes(bad, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), `route "a"`) || out.Len() != 0 {
		t.Errorf("bad file: code %d, stderr %q", code, errOut.String())
	}
	if code := checkRoutes(filepath.Join(dir, "missing.json"), &out, &errOut); code != 1 {
		t.Errorf("missing file: code %d", code)
	}
}

func TestReloadOnHangup(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	hup := make(chan os.Signal)
	reloads := make(chan struct{})
	results := []error{nil, errors.New("route \"a\": timeout: must be positive"), nil}
	reload := func() error {
		err := results[0]
		results = results[1:]
		reloads <- struct{}{}
		return err
	}
	done := make(chan struct{})
	go func() {
		reloadOnHangup(ctx, hup, reload, logging.Discard())
		close(done)
	}()
	for range 3 {
		hup <- syscall.SIGHUP
		<-reloads // a rejected file does not stop the loop
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("reloadOnHangup did not return after the context ended")
	}
}

func TestUpstreamTransport(t *testing.T) {
	cfg := config.Config{DialTimeout: 2 * time.Second, MaxIdleConns: 7}
	tr := newUpstreamTransport(cfg)
	if tr.Proxy != nil {
		t.Error("the upstream transport must not use proxies from the environment")
	}
	if !tr.DisableCompression {
		t.Error("the upstream transport must pass encodings through")
	}
	if tr.MaxIdleConnsPerHost != 7 || tr.DialContext == nil {
		t.Errorf("MaxIdleConnsPerHost %d", tr.MaxIdleConnsPerHost)
	}
}
