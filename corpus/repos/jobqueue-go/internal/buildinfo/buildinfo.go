// Package buildinfo reports which build of the service is running, from the information the
// Go toolchain embeds in every binary.
package buildinfo

import (
	"runtime/debug"
	"strings"
)

// Info identifies a build.
type Info struct {
	Version   string // module version, or "(devel)" for a build from a checkout
	Revision  string // VCS revision, with a "-dirty" suffix when the tree had local changes
	BuildTime string // commit time of the revision, RFC 3339
	GoVersion string
}

// Read returns the running binary's build information. Fields the toolchain did not record are
// "unknown".
func Read() Info {
	info := Info{Version: "unknown", Revision: "unknown", BuildTime: "unknown", GoVersion: "unknown"}
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return info
	}
	return fromBuildInfo(bi)
}

func fromBuildInfo(bi *debug.BuildInfo) Info {
	info := Info{Version: "unknown", Revision: "unknown", BuildTime: "unknown", GoVersion: bi.GoVersion}
	if v := bi.Main.Version; v != "" {
		info.Version = v
	}
	dirty := false
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			info.Revision = s.Value
		case "vcs.time":
			info.BuildTime = s.Value
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}
	if dirty && info.Revision != "unknown" && !strings.HasSuffix(info.Revision, "-dirty") {
		info.Revision += "-dirty"
	}
	return info
}

// String formats the build for humans, e.g. "v1.4.0 (3f2a9c1, go1.25.0)".
func (i Info) String() string {
	rev := i.Revision
	if len(rev) > 12 && !strings.HasSuffix(rev, "-dirty") {
		rev = rev[:12]
	}
	return i.Version + " (" + rev + ", " + i.GoVersion + ")"
}
