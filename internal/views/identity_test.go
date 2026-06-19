package views_test

import (
	"encoding/json"
	"testing"

	"console/internal/views"
)

func TestOrderIdentity(t *testing.T) {
	cases := []struct {
		name, doc, want string
	}{
		{"present", `{"views":{"order":{"identity":"/gateways/0/name"}}}`, "/gateways/0/name"},
		{"absent", `{"views":{"order":{"include":["x"]}}}`, ""},
		{"no order", `{"views":{"routes":{"identity":"/a"}}}`, ""},
		{"broken json", `{broken`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := views.OrderIdentity([]byte(c.doc)); got != c.want {
				t.Fatalf("OrderIdentity = %q, want %q", got, c.want)
			}
		})
	}
}

func TestResolvePointer(t *testing.T) {
	var data any
	_ = json.Unmarshal([]byte(`{
		"naming": {"projectTag": "nbox"},
		"gateways": [{"name": "main", "port": 443, "tls": true}],
		"empty": ""
	}`), &data)

	cases := []struct {
		name, ptr, want string
		ok              bool
	}{
		{"string", "/gateways/0/name", "main", true},
		{"nested object", "/naming/projectTag", "nbox", true},
		{"number", "/gateways/0/port", "443", true},
		{"bool", "/gateways/0/tls", "true", true},
		{"empty string resolves", "/empty", "", true},
		{"missing key", "/gateways/0/nope", "", false},
		{"index out of range", "/gateways/3/name", "", false},
		{"non-numeric index", "/gateways/x/name", "", false},
		{"object not scalar", "/naming", "", false},
		{"not a pointer", "naming", "", false},
		{"empty pointer", "", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := views.ResolvePointer(data, c.ptr)
			if got != c.want || ok != c.ok {
				t.Fatalf("ResolvePointer(%q) = (%q, %t), want (%q, %t)", c.ptr, got, ok, c.want, c.ok)
			}
		})
	}
}
