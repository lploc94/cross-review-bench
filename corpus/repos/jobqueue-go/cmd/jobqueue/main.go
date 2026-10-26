// Command jobqueue runs the job queue service: the HTTP API, the worker pool, the cron
// scheduler and the lease reaper, all in one process. Configuration comes from the environment;
// see internal/config.
package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/api"
	"github.com/relaywork/jobqueue/internal/buildinfo"
	"github.com/relaywork/jobqueue/internal/builtin"
	"github.com/relaywork/jobqueue/internal/clock"
	"github.com/relaywork/jobqueue/internal/config"
	"github.com/relaywork/jobqueue/internal/domain"
	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/internal/metrics"
	"github.com/relaywork/jobqueue/internal/migrate"
	"github.com/relaywork/jobqueue/internal/scheduler"
	"github.com/relaywork/jobqueue/internal/store"
	"github.com/relaywork/jobqueue/internal/worker"
	"github.com/relaywork/jobqueue/migrations"
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
			logger.Error("jobqueue stopped with an error", "error", err)
			os.Exit(1)
		}
	case len(os.Args) == 2 && os.Args[1] == "version":
		fmt.Println("jobqueue", buildinfo.Read())
	case os.Args[1] == "migrate" && (len(os.Args) == 2 || len(os.Args) == 3 && os.Args[2] == "status"):
		db, err := config.LoadDatabase(os.LookupEnv)
		if err != nil {
			bootLog.Error("invalid configuration", "error", err)
			os.Exit(2)
		}
		logger := logging.New(os.Stdout, slog.LevelInfo)
		if len(os.Args) == 3 {
			err = migrationStatus(db, os.Stdout)
		} else {
			err = migrateOnly(db, logger)
		}
		if err != nil {
			logger.Error("migration failed", "error", err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "usage: jobqueue [migrate [status] | version]")
		os.Exit(2)
	}
}

// migrationStatus prints each migration and when it was applied.
func migrationStatus(db config.Database, w io.Writer) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pool, err := openPool(ctx, db)
	if err != nil {
		return err
	}
	defer pool.Close()
	states, err := migrate.Status(ctx, pool, migrations.FS)
	if err != nil {
		return err
	}
	tw := tabwriter.NewWriter(w, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MIGRATION\tAPPLIED")
	for _, st := range states {
		applied := "pending"
		if st.AppliedAt != nil {
			applied = st.AppliedAt.Format(time.RFC3339)
		}
		fmt.Fprintf(tw, "%s\t%s\n", st.File, applied)
	}
	return tw.Flush()
}

// migrateOnly applies pending migrations and exits, for deployments that migrate in a separate
// step before rolling out new instances.
func migrateOnly(db config.Database, logger *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	pool, err := openPool(ctx, db)
	if err != nil {
		return err
	}
	defer pool.Close()
	applied, err := migrate.Apply(ctx, pool, migrations.FS, logger)
	if err != nil {
		return err
	}
	logger.Info("database is up to date", "applied", len(applied))
	return nil
}

func run(cfg config.Config, logger *slog.Logger) error {
	build := buildinfo.Read()
	logger.Info("starting jobqueue", "version", build.Version, "revision", build.Revision, "go", build.GoVersion)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := openPool(ctx, cfg.Database)
	if err != nil {
		return err
	}
	defer pool.Close()

	if _, err := migrate.Apply(ctx, pool, migrations.FS, logger); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	clk := clock.Real{}
	st := store.New(pool, clk)
	reg := metrics.NewRegistry()
	registerPoolMetrics(reg, pool)
	reg.NewGauge("jobqueue_build_info", "Always 1; the labels identify the running build.",
		"version", "revision", "go_version").Set(1, build.Version, build.Revision, build.GoVersion)

	server, err := api.New(api.Options{Store: st, AdminToken: cfg.AdminToken, Clock: clk, Logger: logger, Metrics: reg})
	if err != nil {
		return err
	}
	handlers := worker.NewRegistry(cfg.JobTimeout)
	builtin.Register(handlers, builtin.Options{Clock: clk, LeaseDuration: cfg.LeaseDuration})
	workers, err := worker.NewPool(st, handlers, worker.Options{
		ID:            cfg.WorkerID,
		Queues:        cfg.WorkerQueues,
		Concurrency:   cfg.WorkerConcurrency,
		PollInterval:  cfg.WorkerPollInterval,
		LeaseDuration: cfg.LeaseDuration,
		Retry:         domain.FixedDelay{Delay: cfg.RetryDelay},
		Clock:         clk,
		Logger:        logger,
		Metrics:       reg,
	})
	if err != nil {
		return err
	}
	reaper, err := worker.NewReaper(st, store.ReapBatchSize, cfg.ReapInterval, clk, logger, reg)
	if err != nil {
		return err
	}
	sched, err := scheduler.New(st, scheduler.Options{Interval: cfg.SchedulerInterval, Clock: clk, Logger: logger, Metrics: reg})
	if err != nil {
		return err
	}

	httpServer := &http.Server{
		Handler:           server,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
		BaseContext:       func(net.Listener) context.Context { return context.WithoutCancel(ctx) },
	}
	listener, err := net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		return fmt.Errorf("listen on %s: %w", cfg.HTTPAddr, err)
	}

	// The worker pool does not take the signal context: in-flight jobs must not be cancelled
	// by SIGTERM. Stop drains it below.
	if err := workers.Start(context.Background()); err != nil {
		listener.Close()
		return err
	}
	var background sync.WaitGroup
	background.Add(2)
	go func() {
		defer background.Done()
		_ = reaper.Run(ctx)
	}()
	go func() {
		defer background.Done()
		_ = sched.Run(ctx)
	}()

	serveErr := make(chan error, 1)
	go func() {
		logger.Info("listening", "addr", listener.Addr().String())
		serveErr <- httpServer.Serve(listener)
	}()

	var runErr error
	select {
	case <-ctx.Done():
		logger.Info("shutting down")
	case err := <-serveErr:
		runErr = fmt.Errorf("http server: %w", err)
		stop() // stop the background loops too
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
	defer cancel()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		logger.Warn("http server did not shut down cleanly", "error", err)
	}
	workers.Stop()
	background.Wait()
	logger.Info("shutdown complete")
	return runErr
}

func openPool(ctx context.Context, db config.Database) (*pgxpool.Pool, error) {
	pcfg, err := pgxpool.ParseConfig(db.URL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	pcfg.MaxConns = db.MaxConns
	pcfg.ConnConfig.RuntimeParams["application_name"] = "jobqueue"
	pool, err := pgxpool.NewWithConfig(ctx, pcfg)
	if err != nil {
		return nil, fmt.Errorf("open database pool: %w", err)
	}
	pingCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("connect to database: %w", err)
	}
	return pool, nil
}

// registerPoolMetrics exposes the database connection pool's state.
func registerPoolMetrics(reg *metrics.Registry, pool *pgxpool.Pool) {
	reg.NewGaugeFunc("jobqueue_db_connections_open", "Open database connections.",
		func() float64 { return float64(pool.Stat().TotalConns()) })
	reg.NewGaugeFunc("jobqueue_db_connections_acquired", "Database connections in use.",
		func() float64 { return float64(pool.Stat().AcquiredConns()) })
	reg.NewGaugeFunc("jobqueue_db_connections_max", "Maximum database connections.",
		func() float64 { return float64(pool.Stat().MaxConns()) })
}
