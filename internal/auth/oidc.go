package auth

import (
	"cmp"
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/url"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"idp/pkg/models"
	"golang.org/x/oauth2"
)

// OIDC authenticates via Keycloak Authorization Code flow (PKCE-ready) and keeps
// server-side sessions in Redis. Access tokens are silently refreshed.
type OIDC struct {
	provider   *oidc.Provider
	verifier   *oidc.IDTokenVerifier
	oauth      oauth2.Config
	sessions   *SessionStore
	rbac       RBAC
	cookieName string
	secure     bool
	postLogin  string
}

var _ Authenticator = (*OIDC)(nil)

// OIDCConfig configures the OIDC authenticator.
type OIDCConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	Scopes       []string
	CookieName   string
	Secure       bool
	// Where to send the browser after a successful login (default "/").
	PostLogin string
}

// NewOIDC discovers the issuer and builds the authenticator.
func NewOIDC(ctx context.Context, c OIDCConfig, sessions *SessionStore, rbac RBAC) (*OIDC, error) {
	provider, err := oidc.NewProvider(ctx, c.Issuer)
	if err != nil {
		return nil, err
	}
	return &OIDC{
		provider: provider,
		verifier: provider.Verifier(&oidc.Config{ClientID: c.ClientID}),
		oauth: oauth2.Config{
			ClientID:     c.ClientID,
			ClientSecret: c.ClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  c.RedirectURL,
			Scopes:       c.Scopes,
		},
		sessions:   sessions,
		rbac:       rbac,
		cookieName: c.CookieName,
		secure:     c.Secure,
		postLogin:  cmp.Or(c.PostLogin, "/"),
	}, nil
}

type claims struct {
	Email    string   `json:"email"`
	Username string   `json:"preferred_username"`
	Name     string   `json:"name"`
	Groups   []string `json:"groups"`
}

func randState() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// safeReturnTo returns p if it is a safe same-origin relative path, else "".
// Guards against open-redirect: the path must start with a single "/" and must
// not begin with "//" or "/\" (which browsers treat as protocol-relative URLs).
func safeReturnTo(p string) string {
	if p == "" || p[0] != '/' {
		return ""
	}
	if len(p) > 1 && (p[1] == '/' || p[1] == '\\') {
		return ""
	}
	return p
}

// resolveReturn places the validated return-to path on the same origin as the
// post-login base. In split-origin dev (callback served on the API host, SPA on
// the Vite host) a bare relative path would otherwise resolve against the API
// origin, which does not serve the SPA. When postLogin is itself relative
// (single-origin prod) the path is returned unchanged. rt is assumed already
// validated by safeReturnTo, so the origin is always taken from trusted config.
func resolveReturn(postLogin, rt string) string {
	base, err := url.Parse(postLogin)
	if err != nil || !base.IsAbs() {
		return rt
	}
	ref, err := url.Parse(rt)
	if err != nil {
		return rt
	}
	return base.ResolveReference(ref).String()
}

func (o *OIDC) Login(w http.ResponseWriter, r *http.Request) {
	state := randState()
	http.SetCookie(w, &http.Cookie{
		Name: "oauth_state", Value: state, Path: "/", HttpOnly: true,
		Secure: o.secure, SameSite: http.SameSiteLaxMode, MaxAge: 300,
	})
	// Remember where to return after callback. Base64-encoded so arbitrary path
	// characters survive cookie sanitization; validated again on the way back.
	if rt := safeReturnTo(r.URL.Query().Get("return_to")); rt != "" {
		http.SetCookie(w, &http.Cookie{
			Name: "oauth_return", Value: base64.RawURLEncoding.EncodeToString([]byte(rt)),
			Path: "/", HttpOnly: true, Secure: o.secure, SameSite: http.SameSiteLaxMode, MaxAge: 300,
		})
	}
	http.Redirect(w, r, o.oauth.AuthCodeURL(state), http.StatusFound)
}

func (o *OIDC) Callback(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	stateCookie, err := r.Cookie("oauth_state")
	if err != nil || stateCookie.Value == "" || stateCookie.Value != r.URL.Query().Get("state") {
		http.Error(w, "invalid state", http.StatusBadRequest)
		return
	}
	oauth2Token, err := o.oauth.Exchange(ctx, r.URL.Query().Get("code"))
	if err != nil {
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	rawID, ok := oauth2Token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token", http.StatusBadGateway)
		return
	}
	idToken, err := o.verifier.Verify(ctx, rawID)
	if err != nil {
		http.Error(w, "invalid id_token", http.StatusUnauthorized)
		return
	}
	var cl claims
	if err := idToken.Claims(&cl); err != nil {
		http.Error(w, "bad claims", http.StatusBadGateway)
		return
	}
	user := o.rbac.BuildUser(idToken.Subject, cl.Email, cl.Username, cl.Name, cl.Groups)
	sess := &Session{
		User:         user,
		AccessToken:  oauth2Token.AccessToken,
		RefreshToken: oauth2Token.RefreshToken,
		IDToken:      rawID,
		Expiry:       oauth2Token.Expiry,
	}
	id, err := o.sessions.Create(ctx, sess)
	if err != nil {
		http.Error(w, "session error", http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: o.cookieName, Value: id, Path: "/", HttpOnly: true,
		Secure: o.secure, SameSite: http.SameSiteLaxMode,
	})
	dest := o.postLogin
	if c, err := r.Cookie("oauth_return"); err == nil && c.Value != "" {
		if raw, derr := base64.RawURLEncoding.DecodeString(c.Value); derr == nil {
			if rt := safeReturnTo(string(raw)); rt != "" {
				dest = resolveReturn(o.postLogin, rt)
			}
		}
		// Consume the one-shot cookie regardless of validity.
		http.SetCookie(w, &http.Cookie{
			Name: "oauth_return", Value: "", Path: "/", HttpOnly: true,
			Secure: o.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1,
		})
	}
	http.Redirect(w, r, dest, http.StatusFound)
}

func (o *OIDC) Authenticate(r *http.Request) (*models.User, error) {
	c, err := r.Cookie(o.cookieName)
	if err != nil || c.Value == "" {
		return nil, ErrUnauthenticated
	}
	sess, err := o.sessions.Get(r.Context(), c.Value)
	if err != nil {
		return nil, ErrUnauthenticated
	}
	// Silent refresh: if the access token expired and we have a refresh token,
	// refresh and persist. On failure, force re-login.
	if !sess.Expiry.IsZero() && time.Now().After(sess.Expiry) && sess.RefreshToken != "" {
		ts := o.oauth.TokenSource(r.Context(), &oauth2.Token{RefreshToken: sess.RefreshToken})
		newTok, err := ts.Token()
		if err != nil {
			_ = o.sessions.Delete(r.Context(), c.Value)
			return nil, ErrUnauthenticated
		}
		sess.AccessToken = newTok.AccessToken
		sess.Expiry = newTok.Expiry
		if newTok.RefreshToken != "" {
			// Persist the rotated refresh token; the IdP invalidates the old one
			// after first use, so dropping it here would break the next refresh.
			sess.RefreshToken = newTok.RefreshToken
		}
		// Persist the rotated tokens and extend the session TTL. Best-effort: a
		// store error must not fail an otherwise-authenticated request.
		_ = o.sessions.Save(r.Context(), c.Value, sess)
	}
	return sess.User, nil
}

func (o *OIDC) Logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(o.cookieName); err == nil && c.Value != "" {
		_ = o.sessions.Delete(r.Context(), c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name: o.cookieName, Value: "", Path: "/", HttpOnly: true,
		Secure: o.secure, SameSite: http.SameSiteLaxMode, MaxAge: -1,
	})
	w.WriteHeader(http.StatusNoContent)
}
