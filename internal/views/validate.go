// Package views validates chart publication view documents: the format
// structure (views.* with include/exclude/overrides/identity/namespace, plus
// optional tabs/actions/defaults) and, when the chart's values.schema.json is present,
// references to real schema fields. The chart schema stays the single source of
// truth; a view only projects its fields. The "defaults" block additionally
// lets a chart declare order-time values the portal stamps in (see Defaults /
// ApplyDefaults in defaults.go).
package views

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Issue is a single validation problem; Path points into the view document
// (JSON pointer), and for schema reference errors, to the referencing field.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// Known ui:widget widgets (see web/src/form/SchemaForm.tsx).
var knownWidgets = map[string]bool{"single": true, "edit": true, "hidden": true}

// ValidateStructure checks only the document format (without the chart schema).
func ValidateStructure(viewJSON []byte) []Issue {
	return Validate(viewJSON, nil)
}

// Validate checks the view document. When schemaJSON is non-empty, it also
// cross-checks include/exclude/overrides/identity against values.schema.json
// fields (an unknown schema structure is skipped silently, we check only what
// we can prove).
func Validate(viewJSON, schemaJSON []byte) []Issue {
	var issues []Issue
	var doc map[string]any
	if err := json.Unmarshal(viewJSON, &doc); err != nil {
		return []Issue{{Path: "", Message: "Невалидный JSON: " + err.Error()}}
	}
	// json.Unmarshal silently collapses duplicate keys (a second "order"
	// would overwrite the first), so we catch them with a token scan before
	// the substantive checks.
	issues = append(issues, duplicateKeys(viewJSON)...)
	for k := range doc {
		switch k {
		case "views", "tabs", "actions", "defaults", "version", "$comment":
		default:
			issues = append(issues, Issue{"/" + k,
				fmt.Sprintf("Лишнее поле %q: на верхнем уровне допустимы только \"views\", \"tabs\", \"actions\", \"defaults\" и \"version\"", k)})
		}
	}
	viewsRaw, ok := doc["views"]
	if !ok {
		return append(issues, Issue{"", `В документе нет блока "views". Добавьте {"views": {"order": { ... }}}`})
	}
	viewsMap, ok := viewsRaw.(map[string]any)
	if !ok {
		return append(issues, Issue{"/views", `Блок "views" должен быть объектом: {"views": {"order": { ... }}}`})
	}
	if len(viewsMap) == 0 {
		issues = append(issues, Issue{"/views", `Блок "views" пуст. Опишите хотя бы view "order" (форму заказа)`})
	}
	// The "order" view is required and exactly one: it builds the order form and
	// the menu item (a duplicate key would be caught by duplicateKeys above).
	if _, ok := viewsMap["order"]; !ok && len(viewsMap) > 0 {
		issues = append(issues, Issue{"",
			`Не хватает view "order": это форма заказа, она обязательна и должна быть ровно одна`})
	}
	// The order view must declare "identity": it names the values field that
	// identifies a deployed instance (e.g. /gateways/0/name). The portal keys
	// per-namespace resource uniqueness on it, so without it two orders of one
	// chart could collide on resource names in a namespace.
	if ov, ok := viewsMap["order"].(map[string]any); ok {
		if _, has := ov["identity"]; !has {
			issues = append(issues, Issue{"/views/order",
				`View "order" должна объявлять "identity": JSON pointer на поле-идентификатор инстанса, например "/gateways/0/name". По нему портал проверяет уникальность ресурсов в namespace`})
		}
	}

	var schema map[string]any
	if len(schemaJSON) > 0 {
		// A broken chart schema is not blamed on the view document, just no cross-checks.
		_ = json.Unmarshal(schemaJSON, &schema)
	}

	// Forms used by a tab as its form project the ELEMENT of the items array, not
	// the schema root, so their include/exclude are checked against element fields.
	formNode := map[string]map[string]any{}
	if tabsArr, ok := doc["tabs"].([]any); ok && schema != nil {
		for _, it := range tabsArr {
			m, _ := it.(map[string]any)
			form, _ := m["form"].(string)
			items, _ := m["items"].(string)
			if form == "" || items == "" {
				continue
			}
			if arr := resolvePointerNode(items, schema, schema); arr != nil {
				formNode[form] = itemNode(arr, schema)
			}
		}
	}

	for name, v := range viewsMap {
		path := "/views/" + name
		vm, ok := v.(map[string]any)
		if !ok {
			issues = append(issues, Issue{path,
				fmt.Sprintf("View %q должна быть объектом с полями include/exclude/overrides", name)})
			continue
		}
		node := schema
		if n, ok := formNode[name]; ok {
			node = n // tab element form: check against array element fields
		}
		issues = append(issues, validateView(path, vm, node, schema, true)...)
	}

	// tabs: product tabs (list tables). Returns the set of tab ids that
	// actions can reference via "tab:<id>".
	tabIDs := map[string]bool{}
	if tabsRaw, ok := doc["tabs"]; ok {
		var tabIssues []Issue
		tabIssues, tabIDs = validateTabs(tabsRaw, viewsMap, schema)
		issues = append(issues, tabIssues...)
	}

	// actions: placement of a view form in the "Actions" menu (info or tab:<id>).
	if actionsRaw, ok := doc["actions"]; ok {
		issues = append(issues, validateActions(actionsRaw, viewsMap, tabIDs)...)
	}

	// defaults: values the portal stamps into an order at create/update time.
	if defaultsRaw, ok := doc["defaults"]; ok {
		issues = append(issues, validateDefaults(defaultsRaw, schema)...)
	}
	return issues
}

// validateDefaults checks the "defaults" block: a map from a JSON pointer over
// values to a scalar the portal stamps into an order (overwriting any submitted
// value). Each key must be a JSON pointer that resolves in values.schema.json
// (when the schema is known); each value must be a scalar.
func validateDefaults(raw any, schema map[string]any) []Issue {
	m, ok := raw.(map[string]any)
	if !ok {
		return []Issue{{"/defaults",
			`Блок "defaults" должен быть объектом: {"/namespace/creator": "console"}`}}
	}
	var issues []Issue
	for ptr, val := range m {
		if !strings.HasPrefix(ptr, "/") {
			issues = append(issues, Issue{"/defaults",
				fmt.Sprintf("Ключ %q должен быть JSON pointer'ом, строкой вида \"/namespace/creator\"", ptr)})
			continue
		}
		p := "/defaults" + ptr
		switch val.(type) {
		case map[string]any, []any:
			issues = append(issues, Issue{p,
				`Значение по умолчанию должно быть скаляром (строка/число/булево)`})
			continue
		}
		if schema != nil && !pointerResolves(ptr, schema, schema) {
			issues = append(issues, Issue{p,
				fmt.Sprintf("Путь %q не находит поле в values.schema.json", ptr)})
		}
	}
	return issues
}

// validateTabs checks product tabs. Each tab is a list table:
// items (JSON pointer to an array in values), form (id of a form from views to
// add/edit an element) and an optional ui:table (columns).
// Returns issues and the set of tab ids (for references from actions).
func validateTabs(raw any, viewsMap, schema map[string]any) ([]Issue, map[string]bool) {
	ids := map[string]bool{}
	arr, ok := raw.([]any)
	if !ok {
		return []Issue{{"/tabs", `Блок "tabs" должен быть массивом: [{"id": "...", "items": "...", "form": "..."}]`}}, ids
	}
	reserved := map[string]bool{"info": true, "history": true, "order": true}
	var issues []Issue
	for i, it := range arr {
		p := fmt.Sprintf("/tabs/%d", i)
		m, ok := it.(map[string]any)
		if !ok {
			issues = append(issues, Issue{p, `Вкладка должна быть объектом {"id": "...", "items": "...", "form": "..."}`})
			continue
		}
		id, _ := m["id"].(string)
		switch {
		case id == "":
			issues = append(issues, Issue{p + "/id", `Укажите "id" вкладки (строка)`})
		case reserved[id]:
			issues = append(issues, Issue{p + "/id", fmt.Sprintf("Id %q зарезервирован (info/history/order)", id)})
		case ids[id]:
			issues = append(issues, Issue{p + "/id", fmt.Sprintf("Вкладка с id %q уже есть", id)})
		default:
			ids[id] = true
		}
		if t, ok := m["title"]; ok {
			if _, ok := t.(string); !ok {
				issues = append(issues, Issue{p + "/title", `Поле "title" должно быть строкой (заголовок вкладки)`})
			}
		}
		if a, ok := m["addLabel"]; ok {
			if _, ok := a.(string); !ok {
				issues = append(issues, Issue{p + "/addLabel", `Поле "addLabel" должно быть строкой (текст пункта «Добавить ...»)`})
			}
		}
		items, _ := m["items"].(string)
		if items == "" || !strings.HasPrefix(items, "/") {
			issues = append(issues, Issue{p + "/items", `Укажите "items": JSON pointer на массив в values, например "/gateways/0/listeners"`})
		} else if schema != nil && !pointerResolves(items, schema, schema) {
			issues = append(issues, Issue{p + "/items", fmt.Sprintf("Путь %q не находит массив в values.schema.json", items)})
		}
		form, _ := m["form"].(string)
		switch form {
		case "":
			issues = append(issues, Issue{p + "/form", `Укажите "form": id формы элемента из блока "views"`})
		case "order":
			issues = append(issues, Issue{p + "/form", `View "order" это форма заказа, она не подходит как форма элемента`})
		default:
			if _, ok := viewsMap[form]; !ok {
				issues = append(issues, Issue{p + "/form", fmt.Sprintf("View %q нет в блоке \"views\"", form)})
			}
		}
		if t, ok := m["ui:table"]; ok {
			// Resolve the list element schema so column paths can be cross-checked
			// against it (items points at the array; a column path is relative to
			// one element). nil when the schema is absent or items is unresolved -
			// then path checks are skipped, mirroring the other "cannot prove" cases.
			var elem map[string]any
			if schema != nil && strings.HasPrefix(items, "/") {
				if arr := resolvePointerNode(items, schema, schema); arr != nil {
					elem = itemNode(arr, schema)
				}
			}
			issues = append(issues, validateUITable(p+"/ui:table", t, elem, schema)...)
		}
		if e, ok := m["enums"]; ok {
			issues = append(issues, validateEnums(p+"/enums", e, schema)...)
		}
	}
	return issues, ids
}

// validateEnums checks a tab's dynamic enums: an array of rules
// {at, from, value}. at - JSON pointer to a field inside the element; from - JSON
// pointer to the source array in values; value - name of the source row field
// that yields the option value.
func validateEnums(path string, raw any, schema map[string]any) []Issue {
	arr, ok := raw.([]any)
	if !ok {
		return []Issue{{path, `Блок "enums" должен быть массивом правил: [{"at": "...", "from": "...", "value": "..."}]`}}
	}
	var issues []Issue
	for i, it := range arr {
		p := fmt.Sprintf("%s/%d", path, i)
		m, ok := it.(map[string]any)
		if !ok {
			issues = append(issues, Issue{p, `Правило enum должно быть объектом {"at": "...", "from": "...", "value": "..."}`})
			continue
		}
		for k := range m {
			switch k {
			case "at", "from", "value":
			default:
				issues = append(issues, Issue{p + "/" + k,
					fmt.Sprintf("Лишнее поле %q: в правиле enum допустимы \"at\", \"from\", \"value\"", k)})
			}
		}
		if s, _ := m["at"].(string); s == "" || !strings.HasPrefix(s, "/") {
			issues = append(issues, Issue{p + "/at",
				`Укажите "at": JSON pointer на поле внутри элемента, например "/parentRefs/0/sectionName"`})
		}
		from, _ := m["from"].(string)
		if from == "" || !strings.HasPrefix(from, "/") {
			issues = append(issues, Issue{p + "/from",
				`Укажите "from": JSON pointer на массив-источник в values, например "/gateways/0/listeners"`})
		} else if schema != nil && !pointerResolves(from, schema, schema) {
			issues = append(issues, Issue{p + "/from",
				fmt.Sprintf("Путь %q не находит массив в values.schema.json", from)})
		}
		if s, _ := m["value"].(string); s == "" {
			issues = append(issues, Issue{p + "/value",
				`Укажите "value": имя поля строки источника, дающее значение опции`})
		}
	}
	return issues
}

// validateColumnLookup checks a computed column: an object {keys, in, match,
// get}. keys - pointer inside the element (may contain "*"); in - pointer
// to an array in values; match/get - names of the array row fields.
func validateColumnLookup(path string, raw any) []Issue {
	m, ok := raw.(map[string]any)
	if !ok {
		return []Issue{{path, `Поле "lookup" должно быть объектом {"keys": "...", "in": "...", "match": "...", "get": "..."}`}}
	}
	var issues []Issue
	for k := range m {
		switch k {
		case "keys", "in", "match", "get":
		default:
			issues = append(issues, Issue{path + "/" + k,
				fmt.Sprintf("Лишнее поле %q: в \"lookup\" допустимы \"keys\", \"in\", \"match\", \"get\"", k)})
		}
	}
	if s, _ := m["keys"].(string); s == "" || !strings.HasPrefix(s, "/") {
		issues = append(issues, Issue{path + "/keys",
			`Укажите "keys": JSON pointer внутри элемента, может содержать "*", например "/parentRefs/*/sectionName"`})
	}
	if s, _ := m["in"].(string); s == "" || !strings.HasPrefix(s, "/") {
		issues = append(issues, Issue{path + "/in",
			`Укажите "in": JSON pointer на массив в values, например "/gateways/0/listeners"`})
	}
	if s, _ := m["match"].(string); s == "" {
		issues = append(issues, Issue{path + "/match",
			`Укажите "match": имя поля строки массива для сравнения с ключом`})
	}
	if s, _ := m["get"].(string); s == "" {
		issues = append(issues, Issue{path + "/get",
			`Укажите "get": имя поля строки массива, чьё значение берём`})
	}
	return issues
}

// validateActions checks the actions section. Each entry places a view form
// (except order, which lives in views) in the "Actions" menu: in "info" (the
// "General info" tab) or in "tab:<id>", where <id> is a tab from the "tabs" block.
func validateActions(raw any, viewsMap map[string]any, tabIDs map[string]bool) []Issue {
	arr, ok := raw.([]any)
	if !ok {
		return []Issue{{"/actions", `Блок "actions" должен быть массивом: [{"view": "...", "in": "info"}]`}}
	}
	var issues []Issue
	for i, it := range arr {
		p := fmt.Sprintf("/actions/%d", i)
		m, ok := it.(map[string]any)
		if !ok {
			issues = append(issues, Issue{p, `Элемент actions должен быть объектом {"view": "...", "in": "info" | "tab:<id>"}`})
			continue
		}
		view, _ := m["view"].(string)
		switch view {
		case "":
			issues = append(issues, Issue{p + "/view", `Укажите "view": имя view из блока "views"`})
		case "order":
			issues = append(issues, Issue{p + "/view", `View "order" это форма заказа, её нельзя класть в «Действия»`})
		default:
			if _, ok := viewsMap[view]; !ok {
				issues = append(issues, Issue{p + "/view", fmt.Sprintf("View %q нет в блоке \"views\"", view)})
			}
		}
		if l, ok := m["label"]; ok {
			if _, ok := l.(string); !ok {
				issues = append(issues, Issue{p + "/label", `Поле "label" должно быть строкой (текст пункта в меню «Действия»)`})
			}
		}
		in, _ := m["in"].(string)
		switch {
		case in == "":
			issues = append(issues, Issue{p + "/in", `Укажите "in": "info" или "tab:<id>"`})
		case in == "info":
			// the "General info" tab always exists
		case strings.HasPrefix(in, "tab:"):
			tab := strings.TrimPrefix(in, "tab:")
			if tab == "" {
				issues = append(issues, Issue{p + "/in", `Укажите вкладку: "tab:<id>"`})
			} else if !tabIDs[tab] {
				issues = append(issues, Issue{p + "/in", fmt.Sprintf("Вкладки %q нет в блоке \"tabs\"", tab)})
			}
		default:
			issues = append(issues, Issue{p + "/in", fmt.Sprintf("Неизвестное размещение %q: допустимо \"info\" или \"tab:<id>\"", in)})
		}
	}
	return issues
}

// validateView checks one view (or a nested ui:view) against a schema node.
// node is the schema node whose fields the view references (nil = cannot check).
func validateView(path string, vm map[string]any, node, root map[string]any, top bool) []Issue {
	var issues []Issue
	props := collectProperties(node, root)

	checkFieldList := func(key string) {
		raw, ok := vm[key]
		if !ok {
			return
		}
		list, ok := raw.([]any)
		if !ok {
			issues = append(issues, Issue{path + "/" + key,
				fmt.Sprintf("Поле %q должно быть массивом имён полей схемы, например [\"naming\", \"gateways\"]", key)})
			return
		}
		for i, item := range list {
			s, ok := item.(string)
			if !ok {
				issues = append(issues, Issue{fmt.Sprintf("%s/%s/%d", path, key, i),
					fmt.Sprintf("Элементы %q должны быть строками, именами полей из values.schema.json", key)})
				continue
			}
			if props != nil && props[s] == nil {
				issues = append(issues, Issue{fmt.Sprintf("%s/%s/%d", path, key, i),
					fmt.Sprintf("Definition %q не найден в values.schema.json. Сверьтесь со вкладкой схемы", s)})
			}
		}
	}

	for k, v := range vm {
		switch k {
		case "$comment":
		case "identity":
			s, ok := v.(string)
			if !ok || !strings.HasPrefix(s, "/") {
				issues = append(issues, Issue{path + "/identity",
					`Поле "identity" должно быть JSON pointer'ом, строкой вида "/gateways/0/name"`})
				continue
			}
			if !top {
				issues = append(issues, Issue{path + "/identity",
					`Поле "identity" допустимо только на верхнем уровне view. Уберите его из ui:view`})
				continue
			}
			if node != nil && !pointerResolves(s, node, root) {
				issues = append(issues, Issue{path + "/identity",
					fmt.Sprintf("Указатель %q не находит поле в values.schema.json. Проверьте путь", s)})
			}
		case "namespace":
			// Binds the order's destination namespace to a values field: a chart
			// that provisions its own namespace (managed-namespace) is rendered into
			// the namespace it creates. The portal mirrors the namespace into it.
			s, ok := v.(string)
			if !ok || !strings.HasPrefix(s, "/") {
				issues = append(issues, Issue{path + "/namespace",
					`Поле "namespace" должно быть JSON pointer'ом, строкой вида "/namespace/namespaceName"`})
				continue
			}
			if !top {
				issues = append(issues, Issue{path + "/namespace",
					`Поле "namespace" допустимо только на верхнем уровне view. Уберите его из ui:view`})
				continue
			}
			if node != nil && !pointerResolves(s, node, root) {
				issues = append(issues, Issue{path + "/namespace",
					fmt.Sprintf("Указатель %q не находит поле в values.schema.json. Проверьте путь", s)})
			}
		case "include", "exclude", "required":
			checkFieldList(k)
		case "overrides":
			om, ok := v.(map[string]any)
			if !ok {
				issues = append(issues, Issue{path + "/overrides",
					`Поле "overrides" должно быть объектом: {"<имя поля>": { настройки }}`})
				continue
			}
			for field, ov := range om {
				fp := path + "/overrides/" + field
				var fieldNode map[string]any
				if props != nil {
					if props[field] == nil {
						issues = append(issues, Issue{fp,
							fmt.Sprintf("Definition %q не найден в values.schema.json. Сверьтесь со вкладкой схемы", field)})
					} else {
						fieldNode, _ = props[field].(map[string]any)
					}
				}
				ovm, ok := ov.(map[string]any)
				if !ok {
					issues = append(issues, Issue{fp,
						"Настройка поля должна быть объектом (title, ui:widget, ui:view, …)"})
					continue
				}
				issues = append(issues, validateOverride(fp, ovm, fieldNode, root)...)
			}
		default:
			issues = append(issues, Issue{path + "/" + k,
				fmt.Sprintf("Неизвестное поле %q: во view допустимы identity, namespace, include, exclude, required, overrides", k)})
		}
	}
	return issues
}

// validateUITable checks the columns of a list tab: an array of objects. A column
// sets either "path" (a slash path into the element; a "*" segment iterates the
// array at that point, e.g. "from/*/namespace") or "lookup" (a value computed
// through a join by reference). label is optional for a path column (defaults to
// path) and required for a lookup column.
func validateUITable(path string, raw any, elem, root map[string]any) []Issue {
	arr, ok := raw.([]any)
	if !ok {
		return []Issue{{path, `Поле "ui:table" должно быть массивом колонок: [{"path": "name", "label": "Имя"}]`}}
	}
	var issues []Issue
	for i, it := range arr {
		p := fmt.Sprintf("%s/%d", path, i)
		m, ok := it.(map[string]any)
		if !ok {
			issues = append(issues, Issue{p, `Колонка должна быть объектом {"path": "...", "label": "..."}`})
			continue
		}
		if lk, ok := m["lookup"]; ok {
			issues = append(issues, validateColumnLookup(p+"/lookup", lk)...)
			if s, ok := m["label"].(string); !ok || s == "" {
				issues = append(issues, Issue{p + "/label", `Для вычисляемой колонки укажите "label" (заголовок)`})
			}
		} else if s, ok := m["path"].(string); !ok || s == "" {
			issues = append(issues, Issue{p + "/path", `Укажите "path": имя поля элемента, например "name", либо задайте "lookup"`})
		} else if elem != nil && !tablePathResolves(s, elem, root) {
			issues = append(issues, Issue{p + "/path",
				fmt.Sprintf("Путь %q не находит поле в элементе списка (values.schema.json). Сверьтесь со вкладкой схемы", s)})
		}
		if l, ok := m["label"]; ok {
			if _, ok := l.(string); !ok {
				issues = append(issues, Issue{p + "/label", `Поле "label" должно быть строкой`})
			}
		}
	}
	return issues
}

// validateOverride checks the known override keys; other keys are
// schema hints (title/description/enum/...), which we skip.
func validateOverride(path string, ovm, fieldNode, root map[string]any) []Issue {
	var issues []Issue
	for k, v := range ovm {
		switch k {
		case "ui:widget":
			s, ok := v.(string)
			if !ok || !knownWidgets[s] {
				issues = append(issues, Issue{path + "/ui:widget",
					fmt.Sprintf("Неизвестный виджет %v: доступны \"single\", \"edit\", \"hidden\"", v)})
			}
		case "ui:view":
			vm, ok := v.(map[string]any)
			if !ok {
				issues = append(issues, Issue{path + "/ui:view",
					`Поле "ui:view" должно быть объектом вложенной view (include/exclude/overrides)`})
				continue
			}
			// A nested ui:view applies to object fields; for an array,
			// to the element (an array renders as a list of cards or as single).
			child := itemNode(fieldNode, root)
			issues = append(issues, validateView(path+"/ui:view", vm, child, root, false)...)
		case "title":
			if _, ok := v.(string); !ok {
				issues = append(issues, Issue{path + "/title", `Поле "title" должно быть строкой`})
			}
		case "include", "exclude", "required", "overrides", "identity", "namespace":
			// These are view keys, not schema hints. Placed directly in a field
			// override (instead of inside "ui:view") they are silently ignored at
			// render time, so flag the misplacement rather than skip it as a hint.
			issues = append(issues, Issue{path + "/" + k,
				fmt.Sprintf("Ключ %q задаёт вложенную view: положите его внутрь \"ui:view\", а не прямо в настройку поля", k)})
		}
	}
	return issues
}

// duplicateKeys uses a token scan to find repeated keys in document objects
// (json.Unmarshal silently collapses them, losing data).
func duplicateKeys(data []byte) []Issue {
	dec := json.NewDecoder(bytes.NewReader(data))
	var scanValue func(path string) []Issue
	scanValue = func(path string) []Issue {
		t, err := dec.Token()
		if err != nil {
			return nil
		}
		d, ok := t.(json.Delim)
		if !ok {
			return nil // scalar
		}
		var issues []Issue
		switch d {
		case '{':
			seen := map[string]bool{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return issues
				}
				key, _ := kt.(string)
				kp := path + "/" + key
				if seen[key] {
					issues = append(issues, Issue{kp,
						fmt.Sprintf("Ключ %q указан дважды, JSON оставит только последнее значение. Уберите дубль", key)})
				}
				seen[key] = true
				issues = append(issues, scanValue(kp)...)
			}
			_, _ = dec.Token() // '}'
		case '[':
			for i := 0; dec.More(); i++ {
				issues = append(issues, scanValue(fmt.Sprintf("%s/%d", path, i))...)
			}
			_, _ = dec.Token() // ']'
		}
		return issues
	}
	return scanValue("")
}

// --- schema navigation ---

// deref resolves a $ref within the schema document (#/definitions/...).
func deref(node, root map[string]any) map[string]any {
	for range 10 { // cycle guard
		ref, _ := node["$ref"].(string)
		if ref == "" || !strings.HasPrefix(ref, "#/") || root == nil {
			return node
		}
		cur := any(root)
		for seg := range strings.SplitSeq(strings.TrimPrefix(ref, "#/"), "/") {
			m, ok := cur.(map[string]any)
			if !ok {
				return node
			}
			cur = m[seg]
		}
		next, ok := cur.(map[string]any)
		if !ok {
			return node
		}
		node = next
	}
	return node
}

// collectProperties gathers a node's merged properties: own + the
// allOf/oneOf/anyOf/then/else branches (fields may live in conditional branches).
// nil if the node is unknown or does not describe an object with properties
// (checks are skipped).
func collectProperties(node, root map[string]any) map[string]any {
	if node == nil {
		return nil
	}
	node = deref(node, root)
	out := map[string]any{}
	var walk func(n map[string]any)
	walk = func(n map[string]any) {
		n = deref(n, root)
		if props, ok := n["properties"].(map[string]any); ok {
			for k, v := range props {
				if _, dup := out[k]; !dup {
					out[k] = v
				}
			}
		}
		for _, branchKey := range []string{"allOf", "oneOf", "anyOf"} {
			if list, ok := n[branchKey].([]any); ok {
				for _, b := range list {
					if bm, ok := b.(map[string]any); ok {
						walk(bm)
					}
				}
			}
		}
		for _, branchKey := range []string{"then", "else"} {
			if bm, ok := n[branchKey].(map[string]any); ok {
				walk(bm)
			}
		}
	}
	walk(node)
	if len(out) == 0 {
		return nil
	}
	return out
}

// itemNode returns the node whose fields a nested ui:view applies to: for an
// array, items (the view describes one element), otherwise the node itself.
func itemNode(node, root map[string]any) map[string]any {
	if node == nil {
		return nil
	}
	node = deref(node, root)
	if t, _ := node["type"].(string); t == "array" {
		items, _ := node["items"].(map[string]any)
		if items == nil {
			return nil
		}
		return deref(items, root)
	}
	return node
}

// pointerResolves checks that a JSON pointer over values (for example
// /gateways/0/name) finds a field in the schema: a numeric segment steps into
// items, others into properties. Unknown parts of the schema count as a match
// (the error cannot be proven).
func pointerResolves(ptr string, node, root map[string]any) bool {
	cur := deref(node, root)
	for seg := range strings.SplitSeq(strings.TrimPrefix(ptr, "/"), "/") {
		if cur == nil {
			return true // schema not described further, do not blame
		}
		if isIndex(seg) {
			if t, _ := cur["type"].(string); t != "" && t != "array" {
				return false
			}
			items, _ := cur["items"].(map[string]any)
			if items == nil {
				return true
			}
			cur = deref(items, root)
			continue
		}
		props := collectProperties(cur, root)
		if props == nil {
			return true // free-form object
		}
		next, ok := props[seg].(map[string]any)
		if !ok {
			return false
		}
		cur = deref(next, root)
	}
	return true
}

// tablePathResolves checks a ui:table column path against the list element
// schema. Unlike a JSON pointer it has no leading slash and is relative to one
// element. Segments: "*"/"*val" iterate an array's items or a string-keyed map's
// values, "*key" a map's keys, a number picks one element (positional), a name
// reads a property. E.g. "from/*/namespace", "selector/*/weight",
// "selector/*key", "selector/*val/0". Unknown/free-form parts count as a match,
// mirroring pointerResolves: only a path we can prove wrong is flagged.
func tablePathResolves(p string, elem, root map[string]any) bool {
	cur := deref(elem, root)
	for seg := range strings.SplitSeq(p, "/") {
		if cur == nil {
			return true // schema not described further, do not blame
		}
		switch {
		case seg == "*key":
			// Keys of a string-keyed map; meaningful only on an object. The keys
			// are terminal strings, so any following segment cannot resolve.
			if t, _ := cur["type"].(string); t != "" && t != "object" {
				return false
			}
			cur = nil
		case seg == "*" || seg == "*val":
			// Iterate an array's items or a map's value schema.
			if items, ok := cur["items"].(map[string]any); ok {
				cur = deref(items, root)
			} else if ap, ok := cur["additionalProperties"].(map[string]any); ok {
				cur = deref(ap, root)
			} else if t, _ := cur["type"].(string); t != "" && t != "array" && t != "object" {
				return false // a described scalar cannot be iterated
			} else {
				cur = nil // array w/o items, free-form map, or undescribed
			}
		case isIndex(seg):
			// Positional pick: into an array's element, else the same-typed item
			// of a collected list (type unchanged).
			if items, ok := cur["items"].(map[string]any); ok {
				cur = deref(items, root)
			}
		default:
			props := collectProperties(cur, root)
			if props == nil {
				return true // free-form object
			}
			next, ok := props[seg].(map[string]any)
			if !ok {
				return false
			}
			cur = deref(next, root)
		}
	}
	return true
}

// resolvePointerNode returns the schema node a JSON pointer over values points
// to (for example /gateways/0/listeners, the listeners array node), or nil if
// the path is not found or the schema is not described further.
func resolvePointerNode(ptr string, node, root map[string]any) map[string]any {
	cur := deref(node, root)
	for seg := range strings.SplitSeq(strings.TrimPrefix(ptr, "/"), "/") {
		if cur == nil {
			return nil
		}
		if isIndex(seg) {
			items, _ := cur["items"].(map[string]any)
			if items == nil {
				return nil
			}
			cur = deref(items, root)
			continue
		}
		props := collectProperties(cur, root)
		if props == nil {
			return nil
		}
		next, ok := props[seg].(map[string]any)
		if !ok {
			return nil
		}
		cur = deref(next, root)
	}
	return cur
}

func isIndex(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
