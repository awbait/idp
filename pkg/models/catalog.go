package models

import "time"

// Chart is a Helm chart (managed service) in the catalog.
type Chart struct {
	Project       string   `json:"project"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	IconURL       string   `json:"icon_url,omitempty"`
	LatestVersion string   `json:"latest_version"`
	Versions      []string `json:"versions"`
	AllowedTeams  []string `json:"allowed_teams,omitempty"` // empty = all teams
	// Author is the first maintainer from Chart.yaml (if any). Used as the author
	// of an auto-discovered publication. The real Harbor client does not parse
	// Chart.yaml yet, so for it this is empty.
	Author string `json:"author,omitempty"`
}

// ChartVersion is a single artifact (version) of a chart.
type ChartVersion struct {
	Project    string    `json:"project"`
	Name       string    `json:"name"`
	Version    string    `json:"version"`
	Digest     string    `json:"digest"`
	AppVersion string    `json:"app_version,omitempty"`
	Created    time.Time `json:"created"`
	Tags       []string  `json:"tags,omitempty"`
}

// ChangelogEntry is one parsed CHANGELOG.md section (Keep a Changelog).
type ChangelogEntry struct {
	Version  string              `json:"version"`
	Date     string              `json:"date,omitempty"`
	Sections map[string][]string `json:"sections"` // "Added"->[...], "Fixed"->[...]
}
