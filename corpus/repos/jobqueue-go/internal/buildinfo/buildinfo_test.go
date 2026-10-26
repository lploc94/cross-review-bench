package buildinfo

import (
	"runtime/debug"
	"testing"
)

func TestFromBuildInfo(t *testing.T) {
	bi := &debug.BuildInfo{
		GoVersion: "go1.25.0",
		Main:      debug.Module{Version: "v1.4.0"},
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "3f2a9c1d0e5b7a8c9d0e1f2a3b4c5d6e7f8a9b0c"},
			{Key: "vcs.time", Value: "2025-03-01T10:00:00Z"},
			{Key: "vcs.modified", Value: "true"},
		},
	}
	info := fromBuildInfo(bi)
	if info.Version != "v1.4.0" || info.Revision != "3f2a9c1d0e5b7a8c9d0e1f2a3b4c5d6e7f8a9b0c-dirty" ||
		info.BuildTime != "2025-03-01T10:00:00Z" || info.GoVersion != "go1.25.0" {
		t.Errorf("info = %+v", info)
	}
	if got := info.String(); got != "v1.4.0 (3f2a9c1d0e5b7a8c9d0e1f2a3b4c5d6e7f8a9b0c-dirty, go1.25.0)" {
		t.Errorf("String() = %q", got)
	}
}

func TestFromBuildInfoWithoutVCS(t *testing.T) {
	info := fromBuildInfo(&debug.BuildInfo{GoVersion: "go1.25.0"})
	if info.Version != "unknown" || info.Revision != "unknown" || info.BuildTime != "unknown" {
		t.Errorf("info = %+v", info)
	}
	if got := info.String(); got != "unknown (unknown, go1.25.0)" {
		t.Errorf("String() = %q", got)
	}
}

func TestStringShortensCleanRevision(t *testing.T) {
	info := Info{Version: "v1", Revision: "0123456789abcdef", GoVersion: "go1.25.0"}
	if got := info.String(); got != "v1 (0123456789ab, go1.25.0)" {
		t.Errorf("String() = %q", got)
	}
}
