// Package changelog parses Keep a Changelog formatted CHANGELOG.md files.
package changelog

import (
	"bufio"
	"bytes"
	"regexp"
	"strings"

	"console/pkg/models"
)

// header matches lines like: ## [15.4.2] - 2026-05-20  (date optional). The
// version/date separator may be a hyphen or an en/em dash (— is common in
// hand-written changelogs), so accept any of -, –, —.
var header = regexp.MustCompile(`^##\s+\[([^\]]+)\](?:\s*[-\x{2013}\x{2014}]\s*(.+))?\s*$`)

// Parse turns CHANGELOG.md content into ordered entries (top-to-bottom).
func Parse(content []byte) []models.ChangelogEntry {
	var entries []models.ChangelogEntry
	var cur *models.ChangelogEntry
	var section string

	sc := bufio.NewScanner(bytes.NewReader(content))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if m := header.FindStringSubmatch(line); m != nil {
			if cur != nil {
				entries = append(entries, *cur)
			}
			cur = &models.ChangelogEntry{
				Version:  strings.TrimSpace(m[1]),
				Date:     strings.TrimSpace(m[2]),
				Sections: map[string][]string{},
			}
			section = ""
			continue
		}
		if cur == nil {
			continue
		}
		if strings.HasPrefix(line, "### ") {
			section = strings.TrimSpace(strings.TrimPrefix(line, "### "))
			continue
		}
		trimmed := strings.TrimSpace(line)
		if (strings.HasPrefix(trimmed, "- ") || strings.HasPrefix(trimmed, "* ")) && section != "" {
			item := strings.TrimSpace(trimmed[2:])
			cur.Sections[section] = append(cur.Sections[section], item)
		}
	}
	if cur != nil {
		entries = append(entries, *cur)
	}
	return entries
}

// ParseVersion returns the single entry matching version, or nil.
func ParseVersion(content []byte, version string) *models.ChangelogEntry {
	for _, e := range Parse(content) {
		if e.Version == version {
			ec := e
			return &ec
		}
	}
	return nil
}
