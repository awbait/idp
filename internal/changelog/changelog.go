// Package changelog serves the portal's own release notes. CHANGELOG.md is
// embedded into the binary and parsed into version sections for the About page.
package changelog

import (
	_ "embed"
	"strings"
)

//go:embed CHANGELOG.md
var raw string

// Release is one version section of the changelog.
type Release struct {
	Version string `json:"version"`
	Date    string `json:"date,omitempty"`
	Body    string `json:"body"` // markdown body of the section (bullets, sub-headings)
}

// Releases parses the embedded CHANGELOG.md into version sections in file order
// (newest first by convention). The leading H1 and any preamble before the first
// "## " heading are ignored.
func Releases() []Release {
	var out []Release
	var cur *Release
	var body []string
	flush := func() {
		if cur == nil {
			return
		}
		cur.Body = strings.TrimSpace(strings.Join(body, "\n"))
		out = append(out, *cur)
		body = nil
	}
	for line := range strings.SplitSeq(raw, "\n") {
		if version, date, ok := parseHeading(line); ok {
			flush()
			cur = &Release{Version: version, Date: date}
			continue
		}
		if cur != nil {
			body = append(body, line)
		}
	}
	flush()
	return out
}

// parseHeading recognises a release heading "## <version>[ - <date>]" (the
// version may be wrapped in [] per Keep a Changelog). Returns ok=false for any
// other line, including the document H1.
func parseHeading(line string) (version, date string, ok bool) {
	if !strings.HasPrefix(line, "## ") {
		return "", "", false
	}
	rest := strings.TrimSpace(strings.TrimPrefix(line, "## "))
	if i := strings.LastIndex(rest, " - "); i >= 0 {
		version, date = strings.TrimSpace(rest[:i]), strings.TrimSpace(rest[i+3:])
	} else {
		version = rest
	}
	return strings.Trim(version, "[]"), date, true
}
