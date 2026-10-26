// Package migrations holds the database schema as numbered SQL files, applied in order by
// internal/migrate.
package migrations

import "embed"

// FS contains the migration files. Each is named <version>_<description>.sql, where version is
// a positive integer; files are applied in ascending version order, each in its own transaction.
//
//go:embed *.sql
var FS embed.FS
