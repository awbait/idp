package config

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

// TestEnvExampleInSync enforces the CLAUDE.md config-sync rule: every env var
// the Config struct reads must be documented in the root .env.example, and the
// example must not list vars the code no longer reads. config.go is the source
// of truth; this test is the backstop so the example never drifts.
func TestEnvExampleInSync(t *testing.T) {
	data, err := os.ReadFile("../../.env.example")
	if err != nil {
		t.Fatalf("read .env.example: %v", err)
	}
	documented := documentedKeys(string(data))

	code := map[string]bool{}
	rt := reflect.TypeFor[Config]()
	for i := 0; i < rt.NumField(); i++ {
		name := rt.Field(i).Tag.Get("env")
		if name == "" {
			continue
		}
		code[name] = true
		if !documented[name] {
			t.Errorf("%s is read by Config but missing from .env.example (add it, see CLAUDE.md)", name)
		}
	}
	for name := range documented {
		if !code[name] {
			t.Errorf("%s is in .env.example but no longer read by Config (remove it)", name)
		}
	}
}

// documentedKeys collects the env var names declared in an .env.example, whether
// active ("KEY=...") or commented out ("# KEY=..."). A name counts as an env key
// only if it is all uppercase letters, digits and underscores.
func documentedKeys(example string) map[string]bool {
	out := map[string]bool{}
	for line := range strings.SplitSeq(example, "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "#"))
		i := strings.IndexByte(line, '=')
		if i <= 0 {
			continue
		}
		if key := line[:i]; isEnvKey(key) {
			out[key] = true
		}
	}
	return out
}

func isEnvKey(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			// allowed character
		default:
			return false
		}
	}
	return s != ""
}
