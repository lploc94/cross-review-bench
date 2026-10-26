// Command gateway runs the API gateway: the proxy listener, the admin listener (admin API,
// health and metrics), the upstream health checkers, route reloads on SIGHUP and a graceful
// shutdown on SIGTERM or SIGINT. Process settings come from the environment (see
// internal/config); routes come from the file ROUTES_FILE names.
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/relaywork/gateway/internal/api"
	"github.com/relaywork/gateway/internal/auth"
	"github.com/relaywork/gateway/internal/buildinfo"
	"github.com/relaywork/gateway/internal/clock"
	"github.com/relaywork/gateway/internal/config"
	"github.com/relaywork/gateway/internal/core"
	"github.com/relaywork/gateway/internal/logging"
	"github.com/relaywork/gateway/internal/metrics"
	"github.com/relaywork/gateway/internal/proxy"
	"github.com/relaywork/gateway/internal/store"
)

func main() {
	// Before the configuration is known, problems are still reported as JSON log lines.
	bootLog := logging.New(os.Stderr, slog.LevelInfo)
	switch {
	case len(os.Args) == 1:
		cfg, err := config.Load()
		if err != nil {
			bootLog.Error("invalid configuration", "error", err)
			os.Exit(2)
		}
		logger := logging.New(os.Stdout, cfg.LogLevel)
		slog.SetDefault(logger)
		if err := run(cfg, logger); err != nil {
			logger.Error("gateway stopped with an error", "error", err)
			os.Exit(1)
		}
	case len(os.Args) == 2 && os.Args[1] == "version":
		fmt.Println("gateway", buildinfo.Read())
	case len(os.Args) == 3 && os.Args[1] == "check-routes":
		os.Exit(checkRoutes(os.Args[2], os.Stdout, os.Stderr))
	default:
		fmt.Fprintln(os.Stderr, "usage: gateway [version | check-routes <file>]")
		os.Exit(2)
	}
}

// checkRoutes validates a routes file without starting anything, for CI and for operators
// before they send SIGHUP. It returns the exit status.
func checkRoutes(path string, stdout, stderr io.Writer) int {
	routes, err := config.LoadRoutes(path)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stdout, "%s: %d routes OK\n", path, len(routes.Routes))
	return 0
}

func run(cfg config.Config, logger *slog.Logger) error {
	build := buildinfo.Read()
	logger.Info("starting gateway", "version", build.Version, "revision", build.Revision, "go", build.GoVersion)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// Catch SIGHUP from the start: its default action would end the process.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)

	rdb, err := store.Open(ctx, cfg.Redis.URL)
	if err != nil {
		return err
	}
	defer rdb.Close()

	clk := clock.Real{}
	st := store.New(rdb, cfg.Redis.KeyPrefix, clk)
	reg := metrics.NewRegistry()
	reg.NewGauge("gateway_build_info", "Always 1; the labels identify the running build.",
		"version", "revision", "go_version").Set(1, build.Version, build.Revision, build.GoVersion)

	rt, err := core.NewRuntime(core.RuntimeOptions{Clock: clk, Logger: logger, Metrics: reg})
	if err != nil {
		return err
	}
	defer rt.Close()
	if err := rt.Reload(cfg.RoutesFile); err != nil {
		return err
	}
	reload := func() error { return rt.Reload(cfg.RoutesFile) }

	proxyHandler, err := proxy.New(proxy.Options{
		Routes: rt,
		Auth: auth.Modes{
			config.AuthAPIKey: &auth.APIKeyAuthenticator{Store: st, Clock: clk, Logger: logger},
			config.AuthHMAC:   &auth.HMACAuthenticator{Store: st, Clock: clk, MaxSkew: cfg.HMACClockSkew},
		},
		RateLimiter:     st.FixedWindow(),
		Transport:       newUpstreamTransport(cfg),
		Clock:           clk,
		Logger:          logger,
		Metrics:         reg,
		TrustedProxies:  cfg.TrustedProxies,
		BodyBufferLimit: cfg.BodyBufferLimit,
	})
	if err != nil {
		return err
	}
	admin, err := api.New(api.Options{
		Store:      st,
		Routes:     rt,
		AdminToken: cfg.AdminToken,
		Reload:     reload,
		Clock:      clk,
		Logger:     logger,
		Metrics:    reg,
	})
	if err != nil {
		return err
	}

	errorLog := slog.NewLogLogger(logger.Handler(), slog.LevelWarn)
	baseContext := func(net.Listener) context.Context { return context.WithoutCancel(ctx) }
	proxyServer := &http.Server{
		Handler:           proxyHandler,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		IdleTimeout:       cfg.IdleTimeout,
		// No read or write timeout: request and response bodies stream for as long as they
		// take, as event streams and large uploads need.
		ErrorLog:    errorLog,
		BaseContext: baseContext,
	}
	adminServer := &http.Server{
		Handler:           admin,
		ReadHeaderTimeout: cfg.ReadHeaderTimeout,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       cfg.IdleTimeout,
		ErrorLog:          errorLog,
		BaseContext:       baseContext,
	}

	proxyListener, err := net.Listen("tcp", cfg.ProxyAddr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.ProxyAddr, err)
	}
	adminListener, err := net.Listen("tcp", cfg.AdminAddr)
	if err != nil {
		proxyListener.Close()
		return fmt.Errorf("listen on %s: %w", cfg.AdminAddr, err)
	}

	var background sync.WaitGroup
	background.Add(1)
	go func() {
		defer background.Done()
		reloadOnHangup(ctx, hup, reload, logger)
	}()

	serveErr := make(chan error, 2)
	serve := func(name string, srv *http.Server, l net.Listener) {
		logger.Info("listening", "listener", name, "addr", l.Addr().String())
		if err := srv.Serve(l); !errors.Is(err, http.ErrServerClosed) {
			serveErr <- fmt.Errorf("%s server: %w", name, err)
		}
	}
	go serve("proxy", proxyServer, proxyListener)
	go serve("admin", adminServer, adminListener)

	var runErr error
	select {
	case <-ctx.Done():
		logger.Info("shutting down", "timeout", cfg.ShutdownTimeout)
	case runErr = <-serveErr:
	}
	stop() // ends the SIGHUP loop too

	// Stop accepting connections and wait for in-flight requests, up to the deadline; then
	// close what is left.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	var shutdown sync.WaitGroup
	for name, srv := range map[string]*http.Server{"proxy": proxyServer, "admin": adminServer} {
		shutdown.Add(1)
		go func() {
			defer shutdown.Done()
			if err := srv.Shutdown(shutdownCtx); err != nil {
				logger.Warn("in-flight requests cut off at the shutdown deadline", "listener", name, "error", err)
				srv.Close()
			}
		}()
	}
	shutdown.Wait()
	background.Wait()
	logger.Info("shutdown complete")
	return runErr
}

// reloadOnHangup reloads the routes file on every SIGHUP until ctx is done. An invalid file is
// logged and the live routes stay in place.
func reloadOnHangup(ctx context.Context, hup <-chan os.Signal, reload func() error, logger *slog.Logger) {
	for {
		select {
		case <-ctx.Done():
			return
		case <-hup:
			if err := reload(); err != nil {
				logger.Error("route reload rejected; keeping the live routes", "error", err)
				continue
			}
			logger.Info("routes reloaded on SIGHUP")
		}
	}
}

// newUpstreamTransport returns the HTTP transport for requests to upstreams. It never uses a
// proxy from the environment and never compresses on its own, so that the gateway passes
// bodies and their encodings through unchanged.
func newUpstreamTransport(cfg config.Config) *http.Transport {
	return &http.Transport{
		Proxy: nil,
		DialContext: (&net.Dialer{
			Timeout:   cfg.DialTimeout,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   cfg.MaxIdleConns,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: time.Second,
		DisableCompression:    true,
	}
}
