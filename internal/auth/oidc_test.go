package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"golang.org/x/oauth2"
)

func TestOIDCLoginSetsNonce(t *testing.T) {
	o := &OIDC{
		oauth: oauth2.Config{
			ClientID:    "portal",
			Endpoint:    oauth2.Endpoint{AuthURL: "http://kc:8081/auth"},
			RedirectURL: "http://host/api/v1/auth/callback",
		},
		secure: true,
	}
	rec := httptest.NewRecorder()
	o.Login(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/login", nil))

	var nonceCookie string
	for _, ck := range rec.Result().Cookies() {
		if ck.Name == "oauth_nonce" {
			nonceCookie = ck.Value
		}
	}
	if nonceCookie == "" {
		t.Fatal("oauth_nonce cookie not set")
	}
	loc, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if got := loc.Query().Get("nonce"); got != nonceCookie {
		t.Fatalf("nonce param = %q, want cookie value %q", got, nonceCookie)
	}
}

func TestSafeReturnTo(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"", ""},
		{"/", "/"},
		{"/orders/123", "/orders/123"},
		{"/orders/123?tab=values", "/orders/123?tab=values"},
		// Open-redirect attempts must be rejected.
		{"//evil.com", ""},
		{"/\\evil.com", ""},
		{"http://evil.com", ""},
		{"https://evil.com", ""},
		{"evil.com", ""},
		{"javascript:alert(1)", ""},
	}
	for _, c := range cases {
		if got := safeReturnTo(c.in); got != c.want {
			t.Errorf("safeReturnTo(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestOIDCLogoutRedirect(t *testing.T) {
	const endSession = "http://kc:8081/realms/internal/protocol/openid-connect/logout"
	const postLogout = "http://host:5173/"

	t.Run("RP-initiated via end_session", func(t *testing.T) {
		o := &OIDC{cookieName: "idp_session", endSession: endSession, postLogout: postLogout}
		rec := httptest.NewRecorder()
		o.Logout(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/logout", nil))

		if rec.Code != http.StatusFound {
			t.Fatalf("status = %d, want 302", rec.Code)
		}
		loc := rec.Header().Get("Location")
		if !strings.HasPrefix(loc, endSession) {
			t.Fatalf("Location %q does not target end_session_endpoint", loc)
		}
		u, err := url.Parse(loc)
		if err != nil {
			t.Fatal(err)
		}
		if got := u.Query().Get("post_logout_redirect_uri"); got != postLogout {
			t.Errorf("post_logout_redirect_uri = %q, want %q", got, postLogout)
		}
		// The session cookie must be cleared on the way out.
		if sc := rec.Result().Cookies(); len(sc) == 0 || sc[0].MaxAge >= 0 {
			t.Errorf("session cookie not cleared: %+v", sc)
		}
	})

	t.Run("fallback when IdP has no end_session", func(t *testing.T) {
		o := &OIDC{cookieName: "idp_session", postLogout: postLogout}
		rec := httptest.NewRecorder()
		o.Logout(rec, httptest.NewRequest(http.MethodGet, "/api/v1/auth/logout", nil))

		if rec.Code != http.StatusFound {
			t.Fatalf("status = %d, want 302", rec.Code)
		}
		if loc := rec.Header().Get("Location"); loc != postLogout {
			t.Errorf("Location = %q, want %q", loc, postLogout)
		}
	})
}

func TestResolveReturn(t *testing.T) {
	cases := []struct {
		postLogin string
		rt        string
		want      string
	}{
		// Split-origin dev: return-to path must land on the SPA origin, not the
		// API origin the callback runs on.
		{"http://10.10.100.33:5173/", "/", "http://10.10.100.33:5173/"},
		{"http://10.10.100.33:5173/", "/orders/123", "http://10.10.100.33:5173/orders/123"},
		{"http://host:5173/", "/orders/123?tab=values", "http://host:5173/orders/123?tab=values"},
		// Single-origin prod: relative postLogin keeps the path relative.
		{"/", "/orders/123", "/orders/123"},
		{"", "/orders/123", "/orders/123"},
	}
	for _, c := range cases {
		if got := resolveReturn(c.postLogin, c.rt); got != c.want {
			t.Errorf("resolveReturn(%q, %q) = %q, want %q", c.postLogin, c.rt, got, c.want)
		}
	}
}
