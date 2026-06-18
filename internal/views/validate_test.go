package views_test

import (
	"strings"
	"testing"

	"console/internal/views"
)

// A schema in the spirit of the real ingress-gateway: definitions + $ref + nesting.
const schema = `{
  "type": "object",
  "properties": {
    "naming": { "type": "object", "properties": { "env": { "type": "string" } } },
    "gateways": { "type": "array", "items": { "$ref": "#/definitions/gateway" } },
    "xroutes": { "type": "array", "items": { "$ref": "#/definitions/xroute" } }
  },
  "definitions": {
    "gateway": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "listeners": { "type": "array", "items": { "type": "object" } },
        "resources": { "type": "object" },
        "hpa": { "type": "object" }
      }
    },
    "xroute": {
      "type": "object",
      "properties": {
        "enabled": { "type": "boolean" },
        "hostnames": { "type": "array", "items": { "type": "string" } },
        "parentRefs": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": { "gateway": { "type": "string" }, "sectionName": { "type": "string" } }
          }
        }
      }
    }
  }
}`

const validDoc = `{
  "$comment": "ок",
  "views": {
    "order": {
      "identity": "/gateways/0/name",
      "include": ["naming", "gateways"],
      "overrides": {
        "gateways": {
          "ui:widget": "single",
          "title": "Gateway",
          "ui:view": { "exclude": ["hpa"] }
        }
      }
    },
    "routes": {
      "include": ["xroutes"],
      "overrides": {
        "xroutes": {
          "ui:view": {
            "exclude": ["enabled", "hostnames"],
            "overrides": { "parentRefs": { "ui:view": { "exclude": ["gateway"] } } }
          }
        }
      }
    }
  }
}`

func hasIssue(issues []views.Issue, pathPart, msgPart string) bool {
	for _, is := range issues {
		if strings.Contains(is.Path, pathPart) && strings.Contains(is.Message, msgPart) {
			return true
		}
	}
	return false
}

func TestValidDocument(t *testing.T) {
	if issues := views.Validate([]byte(validDoc), []byte(schema)); len(issues) > 0 {
		t.Fatalf("want no issues, got %+v", issues)
	}
}

func TestStructuralIssues(t *testing.T) {
	cases := []struct {
		name, doc, path, msg string
	}{
		{"broken json", `{broken`, "", "Невалидный JSON"},
		{"no views", `{"version":1}`, "", `"views"`},
		{"views not object", `{"views":[]}`, "/views", "объект"},
		{"unknown root key", `{"views":{"order":{}},"viws":{}}`, "/viws", "Лишнее поле"},
		{"unknown view key", `{"views":{"order":{"includ":["x"]}}}`, "/views/order/includ", "Неизвестное поле"},
		{"include not array", `{"views":{"order":{"include":"naming"}}}`, "/views/order/include", "массивом"},
		{"bad widget", `{"views":{"order":{"overrides":{"x":{"ui:widget":"fancy"}}}}}`, "ui:widget", "single"},
		{"identity not pointer", `{"views":{"order":{"identity":"gateways"}}}`, "/identity", "pointer"},
		{"identity nested", `{"views":{"order":{"overrides":{"x":{"ui:view":{"identity":"/a"}}}}}}`, "ui:view/identity", "верхнем уровне"},
		// view "order", exactly one.
		{"order missing", `{"views":{"routes":{}}}`, "", `Не хватает view "order"`},
		{"order duplicated", `{"views":{"order":{},"order":{}}}`, "/views/order", "указан дважды"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := views.Validate([]byte(c.doc), nil)
			if !hasIssue(issues, c.path, c.msg) {
				t.Fatalf("want issue %q at %q, got %+v", c.msg, c.path, issues)
			}
		})
	}
}

func TestSchemaCrossChecks(t *testing.T) {
	cases := []struct {
		name, doc, path, msg string
	}{
		{
			"include unknown field",
			`{"views":{"order":{"include":["naming","nope"]}}}`,
			"/views/order/include/1", `Definition "nope" не найден`,
		},
		{
			"override unknown field",
			`{"views":{"order":{"overrides":{"nope":{"title":"x"}}}}}`,
			"/views/order/overrides/nope", `Definition "nope" не найден`,
		},
		{
			"nested exclude unknown (через $ref и массив)",
			`{"views":{"order":{"overrides":{"gateways":{"ui:view":{"exclude":["nope"]}}}}}}`,
			"ui:view/exclude/0", "Definition",
		},
		{
			// Rule: include inside overrides.gateways.ui:view is checked against
			// the properties of the gateways array element (gateways[].nosuch does not exist).
			"nested include unknown (gateways[].items)",
			`{"views":{"order":{"include":["gateways"],"overrides":{"gateways":{"ui:view":{"include":["nosuch"]}}}}}}`,
			"overrides/gateways/ui:view/include/0", `Definition "nosuch" не найден`,
		},
		{
			"identity unresolved",
			`{"views":{"order":{"identity":"/gateways/0/nope"}}}`,
			"/identity", "не находит",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := views.Validate([]byte(c.doc), []byte(schema))
			if !hasIssue(issues, c.path, c.msg) {
				t.Fatalf("want issue %q at %q, got %+v", c.msg, c.path, issues)
			}
		})
	}
}

// A correctly written nested include (gateways[].listeners) passes without errors.
func TestNestedIncludeValid(t *testing.T) {
	doc := `{"views":{"order":{
		"include":["gateways"],
		"overrides":{"gateways":{"ui:widget":"single","ui:view":{"include":["listeners"]}}}
	}}}`
	if issues := views.Validate([]byte(doc), []byte(schema)); len(issues) > 0 {
		t.Fatalf("gateways[].listeners must validate, got %+v", issues)
	}
}

// tabs section: list tabs (items + form + ui:table).
func TestTabsValid(t *testing.T) {
	doc := `{"views":{"order":{},"listener":{}},"tabs":[
		{"id":"listeners","title":"Слушатели","items":"/gateways/0/listeners","form":"listener",
		 "ui:table":[{"path":"name","label":"Имя"},{"path":"port"}]}
	]}`
	if issues := views.Validate([]byte(doc), nil); len(issues) > 0 {
		t.Fatalf("valid tabs, got %+v", issues)
	}
}

func TestTabsIssues(t *testing.T) {
	// Base: one listener form in views, the tab is filled in per case.
	cases := []struct{ name, doc, path, msg string }{
		{"not array", `{"views":{"order":{}},"tabs":{}}`, "/tabs", "массивом"},
		{"id missing", `{"views":{"order":{},"listener":{}},"tabs":[{"items":"/x","form":"listener"}]}`, "/tabs/0/id", `Укажите "id"`},
		{"id reserved", `{"views":{"order":{},"listener":{}},"tabs":[{"id":"info","items":"/x","form":"listener"}]}`, "/tabs/0/id", "зарезервирован"},
		{"id dup", `{"views":{"order":{},"listener":{}},"tabs":[{"id":"a","items":"/x","form":"listener"},{"id":"a","items":"/y","form":"listener"}]}`, "/tabs/1/id", "уже есть"},
		{"items missing", `{"views":{"order":{},"listener":{}},"tabs":[{"id":"a","form":"listener"}]}`, "/tabs/0/items", `Укажите "items"`},
		{"form missing", `{"views":{"order":{}},"tabs":[{"id":"a","items":"/x"}]}`, "/tabs/0/form", `Укажите "form"`},
		{"form order", `{"views":{"order":{}},"tabs":[{"id":"a","items":"/x","form":"order"}]}`, "/tabs/0/form", "форма заказа"},
		{"form unknown", `{"views":{"order":{}},"tabs":[{"id":"a","items":"/x","form":"nope"}]}`, "/tabs/0/form", "нет в блоке"},
		{"ui:table not array", `{"views":{"order":{},"listener":{}},"tabs":[{"id":"a","items":"/x","form":"listener","ui:table":{}}]}`, "/tabs/0/ui:table", "массивом"},
		{"ui:table path missing", `{"views":{"order":{},"listener":{}},"tabs":[{"id":"a","items":"/x","form":"listener","ui:table":[{"label":"Имя"}]}]}`, "/tabs/0/ui:table/0/path", `Укажите "path"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := views.Validate([]byte(c.doc), nil)
			if !hasIssue(issues, c.path, c.msg) {
				t.Fatalf("want issue %q at %q, got %+v", c.msg, c.path, issues)
			}
		})
	}
}

// enums (dynamic enums) + lookup columns: a valid document against the schema.
func TestTabsEnumsLookupValid(t *testing.T) {
	doc := `{"views":{"order":{},"route":{}},"tabs":[
		{"id":"routes","items":"/xroutes","form":"route",
		 "enums":[{"at":"/parentRefs/0/sectionName","from":"/gateways/0/listeners","value":"name"}],
		 "ui:table":[{"path":"name","label":"Имя"},
			{"label":"Hostnames","lookup":{"keys":"/parentRefs/*/sectionName","in":"/gateways/0/listeners","match":"name","get":"hostname"}}]}
	]}`
	if issues := views.Validate([]byte(doc), []byte(schema)); len(issues) > 0 {
		t.Fatalf("valid enums/lookup, got %+v", issues)
	}
}

func TestTabsEnumsLookupIssues(t *testing.T) {
	base := func(tab string) string { return `{"views":{"order":{},"route":{}},"tabs":[` + tab + `]}` }
	cases := []struct{ name, doc, path, msg string }{
		{"enums not array", base(`{"id":"a","items":"/xroutes","form":"route","enums":{}}`), "/tabs/0/enums", "массивом"},
		{"enum at missing", base(`{"id":"a","items":"/xroutes","form":"route","enums":[{"from":"/gateways/0/listeners","value":"name"}]}`), "/tabs/0/enums/0/at", `Укажите "at"`},
		{"enum value missing", base(`{"id":"a","items":"/xroutes","form":"route","enums":[{"at":"/parentRefs/0/sectionName","from":"/gateways/0/listeners"}]}`), "/tabs/0/enums/0/value", `Укажите "value"`},
		{"enum unknown key", base(`{"id":"a","items":"/xroutes","form":"route","enums":[{"at":"/parentRefs/0/sectionName","from":"/gateways/0/listeners","value":"name","oops":1}]}`), "/tabs/0/enums/0/oops", "Лишнее поле"},
		{"enum from not resolve", base(`{"id":"a","items":"/xroutes","form":"route","enums":[{"at":"/parentRefs/0/sectionName","from":"/nope","value":"name"}]}`), "/tabs/0/enums/0/from", "не находит"},
		{"lookup not object", base(`{"id":"a","items":"/xroutes","form":"route","ui:table":[{"label":"H","lookup":[]}]}`), "/tabs/0/ui:table/0/lookup", "объектом"},
		{"lookup get missing", base(`{"id":"a","items":"/xroutes","form":"route","ui:table":[{"label":"H","lookup":{"keys":"/parentRefs/*/sectionName","in":"/gateways/0/listeners","match":"name"}}]}`), "/tabs/0/ui:table/0/lookup/get", `Укажите "get"`},
		{"lookup column no label", base(`{"id":"a","items":"/xroutes","form":"route","ui:table":[{"lookup":{"keys":"/k","in":"/gateways/0/listeners","match":"name","get":"hostname"}}]}`), "/tabs/0/ui:table/0/label", "вычисляемой колонки"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := views.Validate([]byte(c.doc), []byte(schema))
			if !hasIssue(issues, c.path, c.msg) {
				t.Fatalf("want issue %q at %q, got %+v", c.msg, c.path, issues)
			}
		})
	}
}

// actions section: placement of a view form in "Actions" (info and a tab from tabs).
func TestActionsValid(t *testing.T) {
	doc := `{"views":{"order":{},"resources":{},"listener":{}},
		"tabs":[{"id":"listeners","items":"/x","form":"listener"}],
		"actions":[
			{"view":"resources","in":"info","label":"Редактировать ресурсы"},
			{"view":"resources","in":"tab:listeners"}
		]}`
	if issues := views.Validate([]byte(doc), nil); len(issues) > 0 {
		t.Fatalf("valid actions, got %+v", issues)
	}
}

func TestActionsIssues(t *testing.T) {
	cases := []struct{ name, doc, path, msg string }{
		{"not array", `{"views":{"order":{}},"actions":{}}`, "/actions", "массивом"},
		{"view missing", `{"views":{"order":{}},"actions":[{"in":"info"}]}`, "/actions/0/view", `Укажите "view"`},
		{"view order", `{"views":{"order":{}},"actions":[{"view":"order","in":"info"}]}`, "/actions/0/view", "форма заказа"},
		{"view unknown", `{"views":{"order":{}},"actions":[{"view":"nope","in":"info"}]}`, "/actions/0/view", "нет в блоке"},
		{"in missing", `{"views":{"order":{},"resources":{}},"actions":[{"view":"resources"}]}`, "/actions/0/in", `Укажите "in"`},
		{"in unknown", `{"views":{"order":{},"resources":{}},"actions":[{"view":"resources","in":"foo"}]}`, "/actions/0/in", "Неизвестное размещение"},
		{"tab missing", `{"views":{"order":{},"resources":{}},"actions":[{"view":"resources","in":"tab:nope"}]}`, "/actions/0/in", "tabs"},
		{"label not string", `{"views":{"order":{},"resources":{}},"actions":[{"view":"resources","in":"info","label":1}]}`, "/actions/0/label", "строкой"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			issues := views.Validate([]byte(c.doc), nil)
			if !hasIssue(issues, c.path, c.msg) {
				t.Fatalf("want issue %q at %q, got %+v", c.msg, c.path, issues)
			}
		})
	}
}

// Without a schema (a chart without values.schema.json) cross-checks stay silent.
func TestNoSchemaSkipsCrossChecks(t *testing.T) {
	doc := `{"views":{"order":{"identity":"/whatever/0/x","include":["anything"]}}}`
	if issues := views.Validate([]byte(doc), nil); len(issues) > 0 {
		t.Fatalf("want no issues without schema, got %+v", issues)
	}
}

// Free-form parts of the schema (an object without properties) produce no false errors.
func TestFreeFormObjectTolerated(t *testing.T) {
	loose := `{"type":"object","properties":{"cfg":{"type":"object"}}}`
	doc := `{"views":{"order":{"overrides":{"cfg":{"ui:view":{"include":["whatever"]}}}}}}`
	if issues := views.Validate([]byte(doc), []byte(loose)); len(issues) > 0 {
		t.Fatalf("want no issues on free-form object, got %+v", issues)
	}
}
