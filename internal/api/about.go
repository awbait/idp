package api

import (
	"net/http"

	"console/internal/buildinfo"
)

// AboutInfo is the payload for GET /api/v1/info: portal build metadata. Available
// to any authenticated user (unlike the admin-only status page, this is purely
// informational).
type AboutInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit,omitempty"`
	BuildDate string `json:"build_date,omitempty"`
	GoVersion string `json:"go_version"`
}

// handleAbout returns the portal version and build metadata.
func (s *Server) handleAbout(w http.ResponseWriter, _ *http.Request) {
	bi := buildinfo.Get()
	writeJSON(w, http.StatusOK, AboutInfo{
		Version:   bi.Version,
		Commit:    bi.Commit,
		BuildDate: bi.BuildDate,
		GoVersion: bi.GoVersion,
	})
}
