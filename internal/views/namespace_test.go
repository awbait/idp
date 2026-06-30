package views

import "testing"

func TestOrderNamespace(t *testing.T) {
	cases := []struct {
		name string
		view string
		want string
	}{
		{"declared", `{"views":{"order":{"namespace":"/namespace/namespaceName"}}}`, "/namespace/namespaceName"},
		{"absent", `{"views":{"order":{"identity":"/x"}}}`, ""},
		{"no order view", `{"views":{"info":{"namespace":"/x"}}}`, ""},
		{"malformed json", `{`, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := OrderNamespace([]byte(c.view)); got != c.want {
				t.Fatalf("OrderNamespace = %q, want %q", got, c.want)
			}
		})
	}
}

func TestBindNamespace(t *testing.T) {
	view := []byte(`{"views":{"order":{"namespace":"/namespace/namespaceName"}}}`)

	t.Run("overwrites existing value and creates parents", func(t *testing.T) {
		values := map[string]any{"namespace": map[string]any{"namespaceName": "stale", "creator": "lk"}}
		out := BindNamespace(values, view, "team-alpha")
		ns := out["namespace"].(map[string]any)
		if ns["namespaceName"] != "team-alpha" {
			t.Fatalf("namespaceName = %v, want team-alpha", ns["namespaceName"])
		}
		if ns["creator"] != "lk" {
			t.Fatalf("sibling key must be untouched, got %v", ns["creator"])
		}
	})

	t.Run("creates the field when absent", func(t *testing.T) {
		out := BindNamespace(map[string]any{}, view, "team-alpha")
		ns, _ := out["namespace"].(map[string]any)
		if ns == nil || ns["namespaceName"] != "team-alpha" {
			t.Fatalf("namespaceName not set, got %v", out)
		}
	})

	t.Run("no-op without a binding", func(t *testing.T) {
		out := BindNamespace(map[string]any{"a": 1}, []byte(`{"views":{"order":{}}}`), "team-alpha")
		if _, ok := out["namespace"]; ok {
			t.Fatalf("must not touch values when no namespace binding declared")
		}
	})

	t.Run("no-op on empty namespace", func(t *testing.T) {
		values := map[string]any{"namespace": map[string]any{"namespaceName": "keep"}}
		out := BindNamespace(values, view, "")
		ns := out["namespace"].(map[string]any)
		if ns["namespaceName"] != "keep" {
			t.Fatalf("empty namespace must not overwrite, got %v", ns["namespaceName"])
		}
	})

	t.Run("nil values map", func(t *testing.T) {
		out := BindNamespace(nil, view, "team-alpha")
		ns, _ := out["namespace"].(map[string]any)
		if ns == nil || ns["namespaceName"] != "team-alpha" {
			t.Fatalf("namespaceName not set on nil input, got %v", out)
		}
	})
}
