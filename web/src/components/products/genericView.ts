// Generic product-page engine. Derives the product page from the chart's view
// document, which has three independent sections:
//   views   - a library of forms (schema projections); "order" is the order form.
//   tabs    - product tabs (list tables); each names an array (items pointer) and
//             the form (a view id) used to add/edit one element, plus ui:table.
//   actions - placement of form-views into an actions menu (info or tab:<id>).
// A tab may also declare dynamic enums (applyEnums) and computed lookup columns
// (computeCell). Save-time auto-fill of hidden fields is the chart's job, not the
// portal's, so there is no prepare/onSave step here.
import { deref, type View } from "../../form/SchemaForm";
import type { ViewDocument, ViewTab } from "../../api/types";

type Schema = Record<string, any>;

// A lookup column joins by reference: collect keys from the item (the "keys"
// pointer, "*" iterates an array), find rows in the `in` array of the order's
// full values where row[match] equals a key, take row[get].
export interface ColumnLookup {
  keys: string;
  in: string;
  match: string;
  get: string;
}

export interface TableColumn {
  path?: string;
  label: string;
  lookup?: ColumnLookup;
}

// A dynamic-enum rule: fill the enum of the field at `at` (a pointer inside one
// item; numeric segment = array element) from the `from` array of the order's
// full values, mapping each row to row[value].
export interface EnumRule {
  at: string;
  from: string;
  value: string;
}

// A tab resolved against the schema: the edited array, one item's schema, the
// element form projection, the table columns and the dynamic-enum rules.
export interface ResolvedTab {
  itemsPath: string;
  itemSchema: Schema;
  minItems: number;
  form: View | undefined;
  columns: TableColumn[];
  enums: EnumRule[];
}

function isIndex(seg: string): boolean {
  return seg !== "" && /^\d+$/.test(seg);
}

// targetArray walks a JSON pointer ("/gateways/0/listeners") through the schema
// and returns the array node it lands on (its item schema + minItems), or null
// when the path doesn't resolve to an array.
function targetArray(schema: Schema, pointer: string): { itemSchema: Schema; minItems: number } | null {
  if (!pointer || !pointer.startsWith("/")) return null;
  let cur = deref(schema, schema);
  for (const seg of pointer.slice(1).split("/")) {
    if (isIndex(seg)) {
      if (cur.type !== "array" || !cur.items) return null;
      cur = deref(cur.items, schema);
      continue;
    }
    const props = cur.properties as Record<string, Schema> | undefined;
    if (!props || !props[seg]) return null;
    cur = deref(props[seg], schema);
  }
  if (cur.type !== "array" || !cur.items) return null;
  return {
    itemSchema: { ...deref(cur.items, schema), definitions: schema.definitions },
    minItems: typeof cur.minItems === "number" ? cur.minItems : 0,
  };
}

// productTabs lists the product tabs declared in the document (in order).
export function productTabs(doc?: ViewDocument | null): ViewTab[] {
  return Array.isArray(doc?.tabs) ? doc!.tabs : [];
}

// resolveTab binds a tab to the schema + its element form. Returns null when the
// tab is unconfigured (items doesn't resolve to an array, or form is missing).
// columns may be empty (then the tab is "not configured" - the table needs them).
export function resolveTab(schema: Schema | null | undefined, tab: ViewTab, doc: ViewDocument): ResolvedTab | null {
  if (!schema) return null;
  const arr = targetArray(schema, tab.items);
  if (!arr) return null;
  if (!tab.form || doc.views?.[tab.form] === undefined) return null;
  const cols = Array.isArray(tab["ui:table"]) ? tab["ui:table"] : [];
  return {
    itemsPath: tab.items,
    itemSchema: arr.itemSchema,
    minItems: arr.minItems,
    form: doc.views?.[tab.form] as View,
    columns: cols.map((c) => ({
      path: c.path != null ? String(c.path) : undefined,
      label: String(c.label ?? c.path ?? ""),
      lookup: c.lookup as ColumnLookup | undefined,
    })),
    enums: Array.isArray(tab.enums) ? (tab.enums as EnumRule[]) : [],
  };
}

// schemaNodeAt walks a JSON pointer ("/parentRefs/0/sectionName") through a
// schema (numeric segment = array items), dereferencing $refs against root for
// navigation, and returns the terminal property node to mutate in place (kept
// undereferenced so an injected enum merges over its $ref), or null.
function schemaNodeAt(schema: Schema, root: Schema, pointer: string): Schema | null {
  if (!pointer.startsWith("/")) return null;
  let cur = deref(schema, root);
  const segs = pointer.slice(1).split("/");
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (isIndex(seg)) {
      if (cur.type !== "array" || !cur.items) return null;
      cur = deref(cur.items, root);
      continue;
    }
    const props = cur.properties as Record<string, Schema> | undefined;
    if (!props || !props[seg]) return null;
    if (i === segs.length - 1) return props[seg];
    cur = deref(props[seg], root);
  }
  return cur;
}

// applyEnums clones the item schema and injects each tab enum rule: the field at
// rule.at gets its enum filled from the rule.from array of the order's full
// values. Returns the schema unchanged when there are no rules.
export function applyEnums(itemSchema: Schema, enums: EnumRule[] | undefined, full: any): Schema {
  if (!enums || enums.length === 0) return itemSchema;
  const out = structuredClone(itemSchema);
  for (const rule of enums) {
    const src = getAt(full, rule.from);
    if (!Array.isArray(src)) continue;
    const values = [...new Set(src.map((x) => x?.[rule.value]).filter((v) => v != null && v !== ""))];
    if (values.length === 0) continue;
    const node = schemaNodeAt(out, out, rule.at);
    if (node) node.enum = values;
  }
  return out;
}

// collectKeys reads values from an item by a slash path. Segments:
//   "*" / "*val" - iterate the array items or, for a string-keyed map (object
//                  with additionalProperties), its values.
//   "*key"       - iterate a map's keys.
//   <number>     - after an iterate segment, pick that element of the collected
//                  list (so "selector/*val/0" is the first value); otherwise it
//                  indexes into each element (array positional, e.g. "to/0").
//   <name>       - read that property of each element.
// So "selector/*/weight" pulls one field out of each map entry's object, and
// "selector/*key" lists the labels.
function collectKeys(item: any, path: string): any[] {
  let cur: any[] = [item];
  // Whether the previous segment expanded a collection, so a following integer
  // means "the Nth collected item" rather than "index into each element".
  let flat = false;
  for (const seg of path.replace(/^\//, "").split("/")) {
    if (seg === "*" || seg === "*val") {
      cur = cur.flatMap((c) =>
        Array.isArray(c) ? c : c && typeof c === "object" ? Object.values(c) : [],
      );
      flat = true;
    } else if (seg === "*key") {
      cur = cur.flatMap((c) =>
        c && typeof c === "object" && !Array.isArray(c) ? Object.keys(c) : [],
      );
      flat = true;
    } else if (/^\d+$/.test(seg) && flat) {
      const i = Number(seg);
      cur = i < cur.length ? [cur[i]] : [];
      flat = false;
    } else {
      cur = cur.map((c) => (c == null ? undefined : c[seg]));
      flat = false;
    }
  }
  return cur.filter((v) => v != null && v !== "");
}

// computeCell returns a column's display value for an item: a lookup column joins
// against the order's full values, a plain column reads the item by path. A path
// with a "*"/"*val"/"*key" segment iterates the array or map at that point (e.g.
// "from/*/namespace", "selector/*/weight", "selector/*key") and returns the
// distinct collected values; a trailing integer picks one (e.g. "selector/*/0").
export function computeCell(item: any, full: any, col: TableColumn): any {
  const lk = col.lookup;
  if (lk) {
    const rows = getAt(full, lk.in);
    if (!Array.isArray(rows)) return undefined;
    const byKey = new Map(rows.map((r) => [r?.[lk.match], r?.[lk.get]]));
    const vals = collectKeys(item, lk.keys)
      .map((k) => byKey.get(k))
      .filter((v) => v != null && v !== "");
    return [...new Set(vals)];
  }
  if (col.path == null) return undefined;
  if (col.path.includes("*")) return [...new Set(collectKeys(item, col.path))];
  return cellValue(item, col.path);
}

// A view placed into an actions menu, with an optional custom menu label.
export interface ActionPlacement {
  view: string;
  label?: string;
}

// actionViews returns the views placed at a given slot: "info" (the general-info
// tab) or "tab:<id>" (a tab's actions menu).
export function actionViews(doc: ViewDocument | null | undefined, placement: string): ActionPlacement[] {
  return (doc?.actions ?? [])
    .filter((a) => a.in === placement)
    .map((a) => ({ view: a.view, label: a.label }));
}

// getAt / setAt read and write a value by JSON pointer ("/a/0/b"), creating
// intermediate arrays/objects on write. Numeric segments index arrays.
export function getAt(root: any, pointer: string): any {
  if (!pointer) return root;
  let cur = root;
  for (const seg of pointer.slice(1).split("/")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setAt(root: any, pointer: string, value: any): void {
  const segs = pointer.slice(1).split("/");
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    const nextIsIndex = /^\d+$/.test(segs[i + 1]);
    if (cur[seg] == null) cur[seg] = nextIsIndex ? [] : {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
}

// cellValue reads a column's value from an array item by its slash path.
export function cellValue(item: any, path: string): any {
  let cur = item;
  for (const seg of path.split("/")) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}
