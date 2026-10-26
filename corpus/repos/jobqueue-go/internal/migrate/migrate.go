// Package migrate applies the numbered SQL migrations in migrations/ to a database.
//
// Applied versions are recorded in the schema_migrations table. A session-level advisory lock
// serializes concurrent runs, so several instances can start at the same time against the same
// database.
package migrate

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// lockKey is the advisory lock that serializes migration runs ("jobq" in ASCII).
const lockKey int64 = 0x6a6f6271

// Migration is one SQL file.
type Migration struct {
	Version int64
	Name    string // the description part of the file name
	File    string
	SQL     string
}

// Load reads every *.sql file at the root of fsys and returns the migrations sorted by version.
// File names must look like 0001_create_jobs.sql; duplicate versions are an error.
func Load(fsys fs.FS) ([]Migration, error) {
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		return nil, fmt.Errorf("read migrations: %w", err)
	}
	var out []Migration
	seen := make(map[int64]string)
	for _, e := range entries {
		if e.IsDir() || path.Ext(e.Name()) != ".sql" {
			continue
		}
		base := strings.TrimSuffix(e.Name(), ".sql")
		num, desc, ok := strings.Cut(base, "_")
		if !ok || desc == "" {
			return nil, fmt.Errorf("migration %s: name must be <version>_<description>.sql", e.Name())
		}
		version, err := strconv.ParseInt(num, 10, 64)
		if err != nil || version <= 0 {
			return nil, fmt.Errorf("migration %s: version %q is not a positive integer", e.Name(), num)
		}
		if prev, dup := seen[version]; dup {
			return nil, fmt.Errorf("migrations %s and %s share version %d", prev, e.Name(), version)
		}
		seen[version] = e.Name()
		body, err := fs.ReadFile(fsys, e.Name())
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", e.Name(), err)
		}
		out = append(out, Migration{Version: version, Name: desc, File: e.Name(), SQL: string(body)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Version < out[j].Version })
	return out, nil
}

// Apply applies the migrations in fsys that the database has not seen yet and returns the
// versions it applied.
func Apply(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS, logger *slog.Logger) ([]int64, error) {
	migrations, err := Load(fsys)
	if err != nil {
		return nil, err
	}
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock($1)", lockKey); err != nil {
		return nil, fmt.Errorf("take migration lock: %w", err)
	}
	defer func() {
		// The lock belongs to the session: release it even when ctx is already done, and close
		// the connection rather than return it to the pool still holding the lock.
		unlockCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		if _, err := conn.Exec(unlockCtx, "SELECT pg_advisory_unlock($1)", lockKey); err != nil {
			logger.Error("release migration lock", "error", err)
			_ = conn.Conn().Close(unlockCtx)
		}
	}()

	if _, err := conn.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version    bigint      PRIMARY KEY,
		name       text        NOT NULL,
		applied_at timestamptz NOT NULL DEFAULT now()
	)`); err != nil {
		return nil, fmt.Errorf("create schema_migrations: %w", err)
	}

	applied, err := appliedVersions(ctx, conn.Conn())
	if err != nil {
		return nil, err
	}
	var done []int64
	for _, m := range migrations {
		if applied[m.Version] {
			continue
		}
		start := time.Now()
		err := pgx.BeginFunc(ctx, conn, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, m.SQL); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", m.Version, m.Name)
			return err
		})
		if err != nil {
			return done, fmt.Errorf("apply migration %s: %w", m.File, err)
		}
		logger.Info("applied migration", "version", m.Version, "name", m.Name, "duration", time.Since(start))
		done = append(done, m.Version)
	}
	return done, nil
}

func appliedVersions(ctx context.Context, conn *pgx.Conn) (map[int64]bool, error) {
	rows, err := conn.Query(ctx, "SELECT version FROM schema_migrations")
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}
	versions, err := pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}
	applied := make(map[int64]bool, len(versions))
	for _, v := range versions {
		applied[v] = true
	}
	return applied, nil
}

// State is a migration and when the database applied it.
type State struct {
	Migration
	AppliedAt *time.Time // nil while the migration is pending
}

// Status reports every migration in fsys and whether the database has applied it. It does not
// take the migration lock, so a concurrent Apply may change the answer.
func Status(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS) ([]State, error) {
	migrations, err := Load(fsys)
	if err != nil {
		return nil, err
	}
	applied := make(map[int64]time.Time)
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('schema_migrations') IS NOT NULL").Scan(&exists); err != nil {
		return nil, fmt.Errorf("look up schema_migrations: %w", err)
	}
	if exists {
		rows, err := pool.Query(ctx, "SELECT version, applied_at FROM schema_migrations")
		if err != nil {
			return nil, fmt.Errorf("read schema_migrations: %w", err)
		}
		var (
			version int64
			at      time.Time
		)
		_, err = pgx.ForEachRow(rows, []any{&version, &at}, func() error {
			applied[version] = at.UTC()
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("read schema_migrations: %w", err)
		}
	}
	out := make([]State, len(migrations))
	for i, m := range migrations {
		out[i] = State{Migration: m}
		if at, ok := applied[m.Version]; ok {
			out[i].AppliedAt = &at
		}
	}
	return out, nil
}
