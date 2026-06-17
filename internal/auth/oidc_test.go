package auth

import "testing"

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
