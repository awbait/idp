// Package auth handles Keycloak OIDC, server-side sessions, and RBAC.
package auth

import (
	"regexp"
	"strings"

	"idp/pkg/models"
)

// RBAC maps Keycloak groups to portal teams and roles. It is deliberately
// tolerant of external IdPs whose group claim may be a nested full path
// (e.g. "/group/group/team-core/group") or use a non-default naming scheme.
type RBAC struct {
	AdminGroups []string
	// SupportGroups / SecurityGroups map to the support / security roles the same
	// way AdminGroups maps to admin (full path or any segment).
	SupportGroups  []string
	SecurityGroups []string
	// TeamPrefix matches against EACH path segment of a group (not just the last),
	// so a prefixed segment anywhere in a nested path resolves
	// ("/group/group/team-core/group" -> team "core"). Empty disables prefix
	// matching.
	TeamPrefix string
	// TeamRegex, when set, overrides TeamPrefix: it is matched against the raw
	// group string and its first capture group is taken as the team name. This
	// covers arbitrary structures (e.g. "^/teams/(.+)$" or "(?:^|/)team-([^/]+)").
	TeamRegex *regexp.Regexp
}

func normalizeGroup(g string) string { return strings.TrimPrefix(g, "/") }

// segments splits a group path into its non-empty segments ("/a/b/c" -> [a b c]).
func segments(g string) []string {
	g = strings.Trim(g, "/")
	if g == "" {
		return nil
	}
	return strings.Split(g, "/")
}

// teamFor derives the team name a group maps to, or "" if it isn't a team group.
func (r RBAC) teamFor(group string) string {
	if r.TeamRegex != nil {
		if m := r.TeamRegex.FindStringSubmatch(group); len(m) > 1 {
			return strings.TrimSpace(m[1])
		}
		return ""
	}
	if r.TeamPrefix != "" {
		// A prefixed segment may sit anywhere in the path, so scan all segments.
		for _, seg := range segments(group) {
			if team, ok := strings.CutPrefix(seg, r.TeamPrefix); ok && team != "" {
				return team
			}
		}
	}
	return ""
}

// groupSet normalizes a configured group list into a lookup set.
func groupSet(groups []string) map[string]struct{} {
	s := make(map[string]struct{}, len(groups))
	for _, g := range groups {
		s[normalizeGroup(g)] = struct{}{}
	}
	return s
}

// inGroupSet reports whether a token group matches a configured set, either as
// the full (slash-stripped) path or as any single path segment. So a group
// configured as "platform-admins" matches a token group at any depth
// (e.g. "/org/platform-admins/sub").
func inGroupSet(group string, set map[string]struct{}) bool {
	if len(set) == 0 {
		return false
	}
	if _, ok := set[normalizeGroup(group)]; ok {
		return true
	}
	for _, seg := range segments(group) {
		if _, ok := set[seg]; ok {
			return true
		}
	}
	return false
}

// BuildUser derives the portal user (teams + role) from OIDC claims. Exactly one
// role is assigned, with precedence admin > support > security > member > auditor.
func (r RBAC) BuildUser(sub, email, username, name string, groups []string) *models.User {
	u := &models.User{Subject: sub, Email: email, Username: username, Name: name, Role: models.RoleAuditor}

	adminSet := groupSet(r.AdminGroups)
	supportSet := groupSet(r.SupportGroups)
	securitySet := groupSet(r.SecurityGroups)

	var admin, support, security bool
	seen := map[string]struct{}{}
	for _, g := range groups {
		if inGroupSet(g, adminSet) {
			admin = true
		}
		if inGroupSet(g, supportSet) {
			support = true
		}
		if inGroupSet(g, securitySet) {
			security = true
		}
		if team := r.teamFor(g); team != "" {
			if _, dup := seen[team]; !dup {
				seen[team] = struct{}{}
				u.Teams = append(u.Teams, team)
			}
		}
	}

	switch {
	case admin:
		u.Role = models.RoleAdmin
	case support:
		// Support and security are pure platform roles: their access comes from the
		// role across all teams, never from a team membership. Drop any teams so the
		// role is unambiguous (no accidental member-style create/delete on own team).
		u.Role = models.RoleSupport
		u.Teams = nil
	case security:
		u.Role = models.RoleSecurity
		u.Teams = nil
	case len(u.Teams) > 0:
		u.Role = models.RoleMember
	}
	// Never return a nil slice: it marshals to JSON null, and the SPA treats teams
	// as an array (user.teams.includes(...)). Empty array keeps the contract stable.
	if u.Teams == nil {
		u.Teams = []string{}
	}
	return u
}
