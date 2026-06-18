package auth

import (
	"encoding/json"
	"errors"
	"net/http"

	"console/pkg/models"
)

// ErrUnauthenticated is returned by Authenticate when no valid session exists.
var ErrUnauthenticated = errors.New("unauthenticated")

// Authenticator authenticates requests and handles the OIDC endpoints.
type Authenticator interface {
	// Authenticate returns the user for the request, or ErrUnauthenticated.
	Authenticate(r *http.Request) (*models.User, error)
	Login(w http.ResponseWriter, r *http.Request)
	Callback(w http.ResponseWriter, r *http.Request)
	Logout(w http.ResponseWriter, r *http.Request)
}

// Middleware authenticates and injects the user into the request context.
func Middleware(a Authenticator) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			u, err := a.Authenticate(r)
			if err != nil || u == nil {
				writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
				return
			}
			next.ServeHTTP(w, r.WithContext(WithUser(r.Context(), u)))
		})
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
