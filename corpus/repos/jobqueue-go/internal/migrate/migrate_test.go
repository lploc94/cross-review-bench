package migrate

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/relaywork/jobqueue/internal/logging"
	"github.com/relaywork/jobqueue/migrations"
)

func TestLoadSortsByVersion(t *testing.T) {
	fsys := fstest.MapFS{
		"0010_late.sql":   {Data: []byte("SELECT 10")},
		"0002_second.sql": {Data: []byte("SELECT 2")},
		"0001_first.sql":  {Data: []byte("SELECT 1")},
		"README.md":       {Data: []byte("not a migration")},
	}
	ms, err := Load(fsys)
	if err != nil {
		t.Fatal(err)
	}
	var got []int64
	for _, m := range ms {
		got = append(got, m.Version)
	}
	if !slices.Equal(got, []int64{1, 2, 10}) || ms[0].Name != "first" || ms[0].SQL != "SELECT 1" {
		t.Errorf("Load = %+v", ms)
	}
}

func TestLoadRejectsBadNames(t *testing.T) {
	cases := map[string]fstest.MapFS{
		"no description":    {"0001.sql": {}},
		"not a number":      {"abc_init.sql": {}},
		"zero version":      {"0000_init.sql": {}},
		"duplicate version": {"0001_a.sql": {}, "1_b.sql": {}},
	}
	for name, fsys := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(fsys); err == nil {
				t.Error("Load accepted the files")
			}
		})
	}
}

func TestEmbeddedMigrationsLoad(t *testing.T) {
	ms, err := Load(migrations.FS)
	if err != nil {
		t.Fatal(err)
	}
	if len(ms) < 2 || ms[0].Version != 1 {
		t.Errorf("embedded migrations = %d, first %d", len(ms), ms[0].Version)
	}
}

// freshSchema returns a pool whose search_path is a new, empty schema.
func freshSchema(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL is not set")
	}
	ctx := context.Background()
	var b [6]byte
	_, _ = rand.Read(b[:])
	schema := pgx.Identifier{"migrate_test_" + hex.EncodeToString(b[:])}.Sanitize()

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = strings.Trim(schema, `"`)
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		pool.Close()
	})
	return pool
}

func TestApplyIsIdempotent(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()
	fsys := fstest.MapFS{
		"0001_create_t.sql": {Data: []byte("CREATE TABLE t (id int); INSERT INTO t VALUES (1);")},
		"0002_add_col.sql":  {Data: []byte("ALTER TABLE t ADD COLUMN name text;")},
	}
	applied, err := Apply(ctx, pool, fsys, logging.Discard())
	if err != nil || !slices.Equal(applied, []int64{1, 2}) {
		t.Fatalf("first Apply = %v, %v", applied, err)
	}
	applied, err = Apply(ctx, pool, fsys, logging.Discard())
	if err != nil || len(applied) != 0 {
		t.Fatalf("second Apply = %v, %v; want nothing applied", applied, err)
	}

	fsys["0003_more.sql"] = &fstest.MapFile{Data: []byte("INSERT INTO t VALUES (2, 'two');")}
	applied, err = Apply(ctx, pool, fsys, logging.Discard())
	if err != nil || !slices.Equal(applied, []int64{3}) {
		t.Fatalf("third Apply = %v, %v", applied, err)
	}
	var n int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM t").Scan(&n); err != nil || n != 2 {
		t.Errorf("rows = %d, %v", n, err)
	}
}

func TestApplyRollsBackFailedMigration(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()
	fsys := fstest.MapFS{
		"0001_ok.sql":     {Data: []byte("CREATE TABLE ok (id int);")},
		"0002_broken.sql": {Data: []byte("CREATE TABLE half (id int); SELECT no_such_column FROM ok;")},
	}
	applied, err := Apply(ctx, pool, fsys, logging.Discard())
	if err == nil || !strings.Contains(err.Error(), "0002_broken") || !slices.Equal(applied, []int64{1}) {
		t.Fatalf("Apply = %v, %v; want version 1 applied and an error for 2", applied, err)
	}
	var exists bool
	if err := pool.QueryRow(ctx, "SELECT to_regclass('half') IS NOT NULL").Scan(&exists); err != nil || exists {
		t.Errorf("table from the failed migration exists = %v (%v)", exists, err)
	}
	var versions []int64
	rows, _ := pool.Query(ctx, "SELECT version FROM schema_migrations ORDER BY version")
	versions, err = pgx.CollectRows(rows, pgx.RowTo[int64])
	if err != nil || !slices.Equal(versions, []int64{1}) {
		t.Errorf("recorded versions = %v, %v", versions, err)
	}
}

func TestConcurrentApplyRunsEachMigrationOnce(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()
	// A second run of this migration would fail on the duplicate table.
	fsys := fstest.MapFS{"0001_create.sql": {Data: []byte("CREATE TABLE once (id int);")}}

	errs := make(chan error, 4)
	start := make(chan struct{})
	for range 4 {
		go func() {
			<-start
			_, err := Apply(ctx, pool, fsys, logging.Discard())
			errs <- err
		}()
	}
	close(start)
	for range 4 {
		if err := <-errs; err != nil {
			t.Error(err)
		}
	}
}

func TestStatus(t *testing.T) {
	pool := freshSchema(t)
	ctx := context.Background()
	fsys := fstest.MapFS{"0001_a.sql": {Data: []byte("CREATE TABLE a (id int);")}}

	states, err := Status(ctx, pool, fsys)
	if err != nil || len(states) != 1 || states[0].AppliedAt != nil {
		t.Fatalf("Status before any migration = %+v, %v", states, err)
	}
	if _, err := Apply(ctx, pool, fsys, logging.Discard()); err != nil {
		t.Fatal(err)
	}
	fsys["0002_b.sql"] = &fstest.MapFile{Data: []byte("CREATE TABLE b (id int);")}
	states, err = Status(ctx, pool, fsys)
	if err != nil || len(states) != 2 {
		t.Fatalf("Status = %+v, %v", states, err)
	}
	if states[0].File != "0001_a.sql" || states[0].AppliedAt == nil || states[1].AppliedAt != nil {
		t.Errorf("states = %+v, want 0001 applied and 0002 pending", states)
	}
}
