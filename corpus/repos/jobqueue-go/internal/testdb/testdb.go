// Package testdb gives each test package a private, migrated PostgreSQL schema.
//
// go test runs packages in parallel against the same DATABASE_URL, so every package works in a
// schema of its own: Run creates it with a random name, applies the migrations into it, points
// the pool's search_path at it, and drops it when the tests finish.
package testdb

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/internal/migrate"
	"github.com/relaywork/jobqueue/migrations"
)

// Run is meant to be called from TestMain:
//
//	var pool *pgxpool.Pool
//
//	func TestMain(m *testing.M) { os.Exit(testdb.Run(m, &pool)) }
//
// Without DATABASE_URL the tests run with a nil pool, and those that call Require skip.
func Run(m *testing.M, dst **pgxpool.Pool) int {
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		return m.Run()
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	pool, drop, err := Open(ctx, url)
	cancel()
	if err != nil {
		fmt.Fprintln(os.Stderr, "testdb:", err)
		return 1
	}
	defer drop()
	*dst = pool
	return m.Run()
}

// Open creates a schema with a random name, applies the migrations into it and returns a pool
// whose connections use it. drop closes the pool and removes the schema.
func Open(ctx context.Context, url string) (pool *pgxpool.Pool, drop func(), err error) {
	var b [6]byte
	_, _ = rand.Read(b[:])
	schema := "test_" + hex.EncodeToString(b[:])

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return nil, nil, fmt.Errorf("connect: %w", err)
	}
	_, err = conn.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize())
	conn.Close(ctx)
	if err != nil {
		return nil, nil, fmt.Errorf("create schema: %w", err)
	}

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, nil, fmt.Errorf("open pool: %w", err)
	}
	drop = func() {
		dropCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if _, err := pool.Exec(dropCtx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			fmt.Fprintf(os.Stderr, "testdb: drop schema %s: %v\n", schema, err)
		}
		pool.Close()
	}
	if _, err := migrate.Apply(ctx, pool, migrations.FS, logging.Discard()); err != nil {
		drop()
		return nil, nil, fmt.Errorf("migrate: %w", err)
	}
	return pool, drop, nil
}

// Require skips the test when no database is configured, and otherwise empties every table so
// that the test starts from a clean state. Tests that use it must not run in parallel with each
// other.
func Require(t testing.TB, pool *pgxpool.Pool) *pgxpool.Pool {
	t.Helper()
	if pool == nil {
		t.Skip("DATABASE_URL is not set")
	}
	if _, err := pool.Exec(context.Background(), "TRUNCATE jobs, schedules RESTART IDENTITY"); err != nil {
		t.Fatalf("reset tables: %v", err)
	}
	return pool
}
