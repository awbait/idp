package auth

import (
	"regexp"
	"testing"

	"idp/pkg/models"
)

func TestBuildUser(t *testing.T) {
	r := RBAC{
		AdminGroups:    []string{"platform-admins"},
		SupportGroups:  []string{"platform-support"},
		SecurityGroups: []string{"infosec"},
		TeamPrefix:     "team-",
	}

	t.Run("member of teams", func(t *testing.T) {
		u := r.BuildUser("s1", "a@b.c", "alice", "Alice", []string{"/team-core", "team-payments", "other"})
		if u.Role != models.RoleMember {
			t.Fatalf("want member, got %s", u.Role)
		}
		if !u.InTeam("core") || !u.InTeam("payments") {
			t.Fatalf("teams not derived: %+v", u.Teams)
		}
		if u.InTeam("other") {
			t.Fatalf("non-prefixed group should not be a team")
		}
	})

	t.Run("admin", func(t *testing.T) {
		u := r.BuildUser("s2", "", "bob", "Bob", []string{"team-core", "platform-admins"})
		if u.Role != models.RoleAdmin || !u.IsAdmin() {
			t.Fatalf("want admin, got %s", u.Role)
		}
	})

	t.Run("auditor with no teams", func(t *testing.T) {
		u := r.BuildUser("s3", "", "carol", "Carol", []string{"some-other-group"})
		if u.Role != models.RoleAuditor {
			t.Fatalf("want auditor, got %s", u.Role)
		}
		// Teams must be a non-nil empty slice: a nil slice marshals to JSON null,
		// which breaks the SPA (it treats teams as an array).
		if u.Teams == nil {
			t.Fatalf("teams must be non-nil empty slice, got nil")
		}
	})

	t.Run("support drops teams", func(t *testing.T) {
		u := r.BuildUser("s6", "", "sam", "Sam", []string{"team-core", "platform-support"})
		if u.Role != models.RoleSupport || !u.IsSupport() {
			t.Fatalf("want support, got %s", u.Role)
		}
		if len(u.Teams) != 0 {
			t.Fatalf("support must not carry teams, got %+v", u.Teams)
		}
	})

	t.Run("security drops teams", func(t *testing.T) {
		u := r.BuildUser("s7", "", "ivy", "Ivy", []string{"team-core", "infosec"})
		if u.Role != models.RoleSecurity || !u.IsSecurity() {
			t.Fatalf("want security, got %s", u.Role)
		}
		if len(u.Teams) != 0 {
			t.Fatalf("security must not carry teams, got %+v", u.Teams)
		}
	})

	t.Run("admin outranks support and security", func(t *testing.T) {
		u := r.BuildUser("s8", "", "max", "Max", []string{"platform-admins", "platform-support", "infosec"})
		if u.Role != models.RoleAdmin {
			t.Fatalf("admin must win, got %s", u.Role)
		}
	})

	t.Run("support outranks security", func(t *testing.T) {
		u := r.BuildUser("s9", "", "sue", "Sue", []string{"platform-support", "infosec"})
		if u.Role != models.RoleSupport {
			t.Fatalf("support must outrank security, got %s", u.Role)
		}
	})

	t.Run("prefixed segment anywhere in path (external IdP)", func(t *testing.T) {
		// The team segment may sit in the MIDDLE of a nested path, and the admin
		// group at any depth - both must still resolve.
		u := r.BuildUser("s4", "", "dave", "Dave",
			[]string{"/group/group/team-core/group", "/org/platform-admins/sub"})
		if !u.InTeam("core") {
			t.Fatalf("mid-path team not derived: %+v", u.Teams)
		}
		if u.Role != models.RoleAdmin {
			t.Fatalf("nested admin group should grant admin, got %s", u.Role)
		}
	})

	t.Run("no duplicate teams", func(t *testing.T) {
		u := r.BuildUser("s5", "", "erin", "Erin", []string{"/team-core", "/org/team-core"})
		if len(u.Teams) != 1 {
			t.Fatalf("expected deduped single team, got %+v", u.Teams)
		}
	})
}

func TestBuildUserRegex(t *testing.T) {
	// Arbitrary structure: teams live under /teams/<name>, no team- prefix.
	r := RBAC{
		AdminGroups: []string{"platform-admins"},
		TeamRegex:   regexp.MustCompile(`^/teams/([^/]+)$`),
	}
	u := r.BuildUser("s1", "", "frank", "Frank", []string{"/teams/core", "/teams/payments", "/team-ignored"})
	if !u.InTeam("core") || !u.InTeam("payments") {
		t.Fatalf("regex teams not derived: %+v", u.Teams)
	}
	if u.InTeam("ignored") {
		t.Fatalf("regex must override prefix: %+v", u.Teams)
	}
	if u.Role != models.RoleMember {
		t.Fatalf("want member, got %s", u.Role)
	}
}
