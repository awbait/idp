// Package buildinfo exposes the portal's version and build metadata. The values
// are injected at build time via ldflags; whatever is not injected falls back to
// the Go toolchain's VCS stamping (debug.ReadBuildInfo), which is present for
// `go build` inside the repo but NOT for `go run` - hence the explicit ldflags
// in the run scripts and Dockerfile.
package buildinfo

import (
	"runtime"
	"runtime/debug"
)

// Injected via -ldflags "-X console/internal/buildinfo.<Name>=<value>". They stay
// at their zero values in unstamped builds, where Get falls back to VCS info.
var (
	Version = "dev"
	Commit  = ""
	Date    = ""
)

// Info is the resolved build metadata returned to callers.
type Info struct {
	Version   string `json:"version"`
	Commit    string `json:"commit,omitempty"`
	BuildDate string `json:"build_date,omitempty"`
	GoVersion string `json:"go_version"`
}

// Get resolves the build metadata: ldflags-injected values first, then the
// toolchain's VCS stamping for any commit/date left empty, plus the Go runtime.
func Get() Info {
	info := Info{Version: Version, Commit: Commit, BuildDate: Date, GoVersion: runtime.Version()}
	if info.Commit != "" && info.BuildDate != "" {
		return info
	}
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return info
	}
	var rev, when string
	dirty := false
	for _, s := range bi.Settings {
		switch s.Key {
		case "vcs.revision":
			rev = shortCommit(s.Value)
		case "vcs.time":
			when = s.Value
		case "vcs.modified":
			dirty = s.Value == "true"
		}
	}
	if dirty && rev != "" {
		rev += "-dirty"
	}
	if info.Commit == "" {
		info.Commit = rev
	}
	if info.BuildDate == "" {
		info.BuildDate = when
	}
	return info
}

// shortCommit trims a full git SHA to the conventional 7-char prefix.
func shortCommit(sha string) string {
	if len(sha) > 7 {
		return sha[:7]
	}
	return sha
}
