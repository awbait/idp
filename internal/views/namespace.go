package views

import "encoding/json"

// OrderNamespace returns the JSON pointer declared as views.order.namespace, the
// values field that holds the namespace a chart provisions for itself (e.g.
// managed-namespace: "/namespace/namespaceName"). Returns "" when absent or
// malformed.
//
// A chart that creates its own namespace names it through a value rather than
// deploying into a pre-existing one. Declaring the pointer lets the portal mirror
// the order's destination namespace into that value, so the chart renders into
// the namespace it creates (no separate input, no chart-specific code).
func OrderNamespace(viewJSON []byte) string {
	var doc struct {
		Views map[string]struct {
			Namespace string `json:"namespace"`
		} `json:"views"`
	}
	if err := json.Unmarshal(viewJSON, &doc); err != nil {
		return ""
	}
	return doc.Views["order"].Namespace
}

// BindNamespace mirrors namespace into the values field named by the view's
// order.namespace pointer, OVERWRITING any value already there. It is a no-op
// when the view declares no pointer or namespace is empty. Returns the (mutated)
// values map. See setPointer for the object-only addressing semantics.
func BindNamespace(values map[string]any, viewJSON []byte, namespace string) map[string]any {
	ptr := OrderNamespace(viewJSON)
	if ptr == "" || namespace == "" {
		return values
	}
	if values == nil {
		values = map[string]any{}
	}
	setPointer(values, ptr, namespace)
	return values
}
