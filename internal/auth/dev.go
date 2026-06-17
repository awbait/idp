package auth

import (
	"net/http"
	"strings"

	"idp/pkg/models"
)

// Dev is a no-Keycloak authenticator for local runs and tests. The user can be
// overridden per-request with headers:
//
//	X-Dev-Sub, X-Dev-Name, X-Dev-Teams (csv), X-Dev-Role (viewer|member|admin)
//
// Defaults to a member of team "core".
type Dev struct {
	Default *models.User
}

var _ Authenticator = (*Dev)(nil)

// NewDev returns a dev authenticator with a sensible default user.
func NewDev() *Dev {
	return &Dev{Default: &models.User{
		Subject: "dev-user", Name: "Dev User", Username: "dev",
		Email: "dev@example.com", Teams: []string{"core"}, Role: models.RoleMember,
	}}
}

func (d *Dev) Authenticate(r *http.Request) (*models.User, error) {
	u := *d.Default
	if v := r.Header.Get("X-Dev-Sub"); v != "" {
		u.Subject = v
	}
	if v := r.Header.Get("X-Dev-Name"); v != "" {
		u.Name = v
	}
	if v := r.Header.Get("X-Dev-Teams"); v != "" {
		u.Teams = splitCSV(v)
	}
	if v := r.Header.Get("X-Dev-Role"); v != "" {
		u.Role = models.Role(v)
	} else if len(u.Teams) == 0 {
		u.Role = models.RoleViewer
	}
	return &u, nil
}

func (d *Dev) Login(w http.ResponseWriter, r *http.Request) {
	dest := "/"
	if rt := safeReturnTo(r.URL.Query().Get("return_to")); rt != "" {
		dest = rt
	}
	http.Redirect(w, r, dest, http.StatusFound)
}
func (d *Dev) Callback(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/", http.StatusFound) }
func (d *Dev) Logout(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }

func splitCSV(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
