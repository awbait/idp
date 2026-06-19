package changelog

import "testing"

func TestParseHeading(t *testing.T) {
	cases := []struct {
		line, version, date string
		ok                  bool
	}{
		{"## [0.1.0] - 2026-06-19", "0.1.0", "2026-06-19", true},
		{"## 0.2.0 - 2026-07-01", "0.2.0", "2026-07-01", true},
		{"## [Unreleased]", "Unreleased", "", true},
		{"# Журнал изменений", "", "", false},
		{"### Добавлено", "", "", false},
		{"- какой-то пункт", "", "", false},
	}
	for _, c := range cases {
		v, d, ok := parseHeading(c.line)
		if ok != c.ok || v != c.version || d != c.date {
			t.Errorf("parseHeading(%q) = (%q,%q,%t), want (%q,%q,%t)", c.line, v, d, ok, c.version, c.date, c.ok)
		}
	}
}

// TestReleasesEmbedded checks the embedded CHANGELOG.md parses into at least one
// section with a non-empty body (guards against an unparseable file shape).
func TestReleasesEmbedded(t *testing.T) {
	rels := Releases()
	if len(rels) == 0 {
		t.Fatal("no releases parsed from embedded CHANGELOG.md")
	}
	if rels[0].Version == "" || rels[0].Body == "" {
		t.Fatalf("first release malformed: %+v", rels[0])
	}
}
