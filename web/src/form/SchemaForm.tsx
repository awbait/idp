import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Button as AriaButton,
  Disclosure,
  DisclosurePanel,
  Heading,
} from "react-aria-components";
import { IconChevronRight, IconTrash, IconX } from "@tabler/icons-react";
import { Button, Checkbox, Hint, Select, TextField } from "../components/ui";

type Schema = Record<string, any>;
type Values = Record<string, unknown>;

// Client-side validation surfaced inline: each field reads its error by JSON
// pointer path. Errors show once the field is touched or after a submit attempt
// (showAll). Backend validation stays the source of truth; this is UX.
type Validation = {
  errors: Map<string, string>;
  touched: Set<string>;
  showAll: boolean;
  mark: (path: string) => void;
};
const ValidationCtx = createContext<Validation>({
  errors: new Map(),
  touched: new Set(),
  showAll: false,
  mark: () => {},
});

// Read-only ("ui:readOnly") support with set-once semantics: a field marked
// readOnly is editable on the create form but locked once the order exists.
// LockActiveCtx says whether the form honors ui:readOnly at all (true when
// editing/upgrading a live order; false on the new-order form). LockedCtx marks
// that we're inside a locked subtree, so a locked object/array disables all its
// descendants too.
const LockActiveCtx = createContext<boolean>(false);
const LockedCtx = createContext<boolean>(false);
const isReadOnly = (s: Schema) => s["ui:readOnly"] === true;

function emptyVal(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

function leafErrors(s: Schema, v: unknown, path: string, out: Map<string, string>) {
  if (emptyVal(v) || typeof v !== "string") return;
  if (typeof s.minLength === "number" && v.length < s.minLength)
    out.set(path, `Минимум ${s.minLength} символов`);
  else if (typeof s.maxLength === "number" && v.length > s.maxLength)
    out.set(path, `Максимум ${s.maxLength} символов`);
  else if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(v))
    out.set(path, "Недопустимый формат");
}

// walkErrors mirrors what the form RENDERS (same view/hidden/required/conditional
// logic as ObjectFields), so we only flag fields the user can actually fill.
function walkErrors(
  node: Schema,
  value: unknown,
  root: Schema,
  view: View | undefined,
  base: string,
  out: Map<string, string>,
) {
  const s = deref(node, root);
  if (isHidden(s)) return;
  if (Array.isArray(s.oneOf)) {
    const opts = s.oneOf.map((o: Schema) => deref(o, root));
    walkErrors(opts[matchVariant(value, opts, root)], value, root, undefined, base, out);
    return;
  }
  if (s.type === "object" && s.properties) {
    const required = new Set<string>([
      ...(s.required ?? []),
      ...conditionalRequired(s, (value as Values) ?? {}, root),
      ...(view?.required ?? []),
    ]);
    for (const k of viewKeys(s, view)) {
      const childNode = view?.overrides?.[k] ? { ...s.properties[k], ...view.overrides[k] } : s.properties[k];
      const child = deref(childNode, root);
      if (isHidden(child)) continue;
      const cv = (value as Values)?.[k];
      const cpath = `${base}/${k}`;
      // A required field with a schema default/const isn't "missing input" — the
      // form shows the default selected and it's applied on submit, so don't flag.
      const hasDefault = "default" in child || "const" in child;
      if (required.has(k) && emptyVal(cv) && !hasDefault) {
        out.set(cpath, "Обязательное поле");
        continue;
      }
      if (cv === undefined) continue;
      walkErrors(childNode, cv, root, child["ui:view"] as View | undefined, cpath, out);
    }
    return;
  }
  if (s.type === "array") {
    const arr = Array.isArray(value) ? value : [];
    if (typeof s.minItems === "number" && arr.length < s.minItems)
      out.set(base, `Минимум ${s.minItems} элемент(ов)`);
    arr.forEach((it, i) => walkErrors(s.items ?? {}, it, root, s["ui:view"] as View | undefined, `${base}/${i}`, out));
    return;
  }
  leafErrors(s, value, base, out);
}

// collectErrors returns invalid field paths (JSON pointer) -> message for the
// given values, honoring the view. Empty map = valid.
export function collectErrors(schema: Schema, value: Values, view?: View): Map<string, string> {
  const out = new Map<string, string>();
  walkErrors(schema, value, schema, view, "", out);
  return out;
}

// A View is a presentation projection over the schema: which top-level fields to
// render and per-field overrides. The schema stays the single source of truth for
// validation; views never copy field definitions. Loaded from a companion
// *.ui.json so one schema can drive several forms (e.g. order vs. routes).
export type View = {
  include?: string[];
  exclude?: string[];
  overrides?: Record<string, Schema>;
  // Force these object keys to render as required (asterisk), on top of the
  // schema's own required. Portal-side UX hint; backend validation is unchanged.
  required?: string[];
};

function viewKeys(schema: Schema, view?: View): string[] {
  const all = orderedKeys(schema);
  if (view?.include) return view.include.filter((k) => all.includes(k));
  if (view?.exclude) return all.filter((k) => !view.exclude!.includes(k));
  return all;
}

// SchemaForm renders a JSON Schema (draft-07, editor flavour) as React Aria
// inputs. Supports: $ref/definitions, propertyOrder, ui:widget:"hidden",
// objects, arrays (add/remove), oneOf (variant picker), additionalProperties
// maps, enum/const, defaults and defaultSnippets. if/then is used to surface
// conditional required fields (see conditionalRequired) but not otherwise
// enforced — the OrderPage offers a raw-YAML fallback for the rest.

function resolvePointer(ref: string, root: Schema): Schema {
  if (!ref.startsWith("#/")) return {};
  let cur: any = root;
  for (const part of ref.slice(2).split("/")) {
    cur = cur?.[decodeURIComponent(part)];
    if (cur == null) return {};
  }
  return cur as Schema;
}

// deref follows $ref, merging sibling keywords (title/description/ui:widget)
// over the resolved target so editor hints on $ref nodes are respected.
export function deref(node: Schema | undefined, root: Schema): Schema {
  let n: Schema = node ?? {};
  let guard = 0;
  while (n && typeof n === "object" && n.$ref && guard++ < 20) {
    const { $ref, ...rest } = n;
    n = { ...resolvePointer($ref, root), ...rest };
  }
  return n;
}

const isHidden = (s: Schema) => s["ui:widget"] === "hidden";

export function orderedKeys(s: Schema): string[] {
  const props = s.properties ? Object.keys(s.properties) : [];
  const order: string[] = Array.isArray(s.propertyOrder) ? s.propertyOrder : [];
  const inOrder = order.filter((k) => props.includes(k));
  return [...inOrder, ...props.filter((k) => !inOrder.includes(k))];
}

// ifMatches evaluates a JSON Schema "if" against a value for the subset we use:
// properties with const/enum, plus the if's own required (presence) list.
function ifMatches(ifSchema: Schema, value: Values, root: Schema): boolean {
  for (const [k, cond] of Object.entries(ifSchema.properties ?? {})) {
    const c = deref(cond as Schema, root);
    const v = value?.[k];
    if ("const" in c && v !== c.const) return false;
    if (Array.isArray(c.enum) && !c.enum.includes(v)) return false;
  }
  for (const k of ifSchema.required ?? []) if (value?.[k] === undefined) return false;
  return true;
}

// conditionalRequired returns keys made required by satisfied if/then branches
// (top-level and inside allOf) for the current value. Mirrors the chart schema's
// conditional requirements (e.g. listener hostname/tlsMode for HTTPS/TLS).
function conditionalRequired(schema: Schema, value: Values, root: Schema): string[] {
  const out: string[] = [];
  const branches: Schema[] = [];
  if (schema.if) branches.push(schema);
  for (const a of (schema.allOf as Schema[]) ?? []) if (a.if) branches.push(a);
  for (const b of branches) {
    if (b.then?.required && ifMatches(b.if, value ?? {}, root)) out.push(...b.then.required);
  }
  return out;
}

// seedDefaults builds an initial value for a schema from const/default.
export function seedDefaults(node: Schema, root: Schema): unknown {
  const s = deref(node, root);
  if ("const" in s) return s.const;
  if ("default" in s) return s.default;
  if (s.oneOf?.length) return seedDefaults(s.oneOf[0], root);
  if (s.type === "object" && s.properties) {
    const obj: Values = {};
    for (const k of Object.keys(s.properties)) {
      const v = seedDefaults(s.properties[k], root);
      if (v !== undefined) obj[k] = v;
    }
    return obj;
  }
  return undefined;
}

function newArrayItem(arr: Schema, root: Schema): unknown {
  const snippet = arr.defaultSnippets?.[0]?.body?.[0];
  if (snippet !== undefined) return structuredClone(snippet);
  const seeded = seedDefaults(arr.items ?? {}, root);
  return seeded === undefined ? {} : seeded;
}

// matchVariant picks which oneOf option the current value corresponds to,
// preferring const discriminators (e.g. filter "type"), then required keys.
function matchVariant(value: unknown, options: Schema[], root: Schema): number {
  if (!value || typeof value !== "object") return 0;
  const v = value as Values;
  for (let i = 0; i < options.length; i++) {
    const o = options[i];
    const props: Record<string, Schema> = o.properties ?? {};
    let ok = true;
    for (const [pk, pv] of Object.entries(props)) {
      const ps = deref(pv, root);
      if ("const" in ps && v[pk] !== undefined && v[pk] !== ps.const) {
        ok = false;
        break;
      }
    }
    if (ok && (o.required ?? []).every((k: string) => v[k] !== undefined)) return i;
  }
  return 0;
}

export function SchemaForm({
  schema,
  value,
  onChange,
  view,
  errors,
  showErrors,
  lockReadOnly = false,
}: {
  schema: Schema;
  value: Values;
  onChange: (v: Values) => void;
  view?: View;
  errors?: Map<string, string>;
  showErrors?: boolean;
  // Honor ui:readOnly fields as disabled (set on edit/upgrade of a live order;
  // leave false on the create form so the field can be set once).
  lockReadOnly?: boolean;
}) {
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const mark = useCallback(
    (p: string) => setTouched((t) => (t.has(p) ? t : new Set(t).add(p))),
    [],
  );
  const validation = useMemo<Validation>(
    () => ({ errors: errors ?? new Map(), touched, showAll: !!showErrors, mark }),
    [errors, touched, showErrors, mark],
  );
  const root = schema;
  const s = deref(schema, root);
  if (s.type !== "object" || !s.properties) {
    return <p className="text-sm text-gray-500">Нет структурной схемы, используйте редактор YAML.</p>;
  }
  return (
    <ValidationCtx.Provider value={validation}>
      <LockActiveCtx.Provider value={lockReadOnly}>
        <ObjectFields schema={s} root={root} value={value} onChange={onChange} view={view} path="" />
      </LockActiveCtx.Provider>
    </ValidationCtx.Provider>
  );
}

function ObjectFields({
  schema,
  root,
  value,
  onChange,
  view,
  path = "",
}: {
  schema: Schema;
  root: Schema;
  value: Values;
  onChange: (v: Values) => void;
  view?: View;
  path?: string;
}) {
  // Effective required = declared required + conditional (if/then) required for
  // the current value, so the form mirrors the schema (e.g. a listener's
  // hostname/tlsMode become required once protocol is HTTPS/TLS).
  const required = new Set<string>([
    ...(schema.required ?? []),
    ...conditionalRequired(schema, value, root),
    ...(view?.required ?? []), // portal-side forced-required hint
  ]);
  const set = (k: string, v: unknown) => {
    if (v === undefined) {
      const { [k]: _drop, ...rest } = value;
      onChange(rest);
    } else {
      onChange({ ...value, [k]: v });
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {viewKeys(schema, view).map((k) => {
        // A view may override a field's schema hints (e.g. render the gateways
        // array as a single object). Overrides shallow-merge onto the node, so
        // existing hints like ui:widget compose. View applies to this level only.
        const node = view?.overrides?.[k]
          ? { ...schema.properties[k], ...view.overrides[k] }
          : schema.properties[k];
        return (
          <Field
            key={k}
            name={k}
            schema={node}
            root={root}
            required={required.has(k)}
            value={value?.[k]}
            onChange={(v) => set(k, v)}
            path={`${path}/${k}`}
          />
        );
      })}
    </div>
  );
}

function Field({
  name,
  schema,
  root,
  required,
  value,
  onChange,
  path = "",
  hideLabel,
}: {
  name: string;
  schema: Schema;
  root: Schema;
  required: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  path?: string;
  // Suppress the visible label (used for primitive array rows).
  hideLabel?: boolean;
}) {
  const validation = useContext(ValidationCtx);
  const lockActive = useContext(LockActiveCtx);
  const ancestorLocked = useContext(LockedCtx);
  const s = deref(schema, root);
  if (isHidden(s)) return null;
  // Locked = inside a locked subtree, or this field is ui:readOnly and the form
  // honors it (edit/upgrade). Locked objects/arrays lock their whole subtree.
  const locked = ancestorLocked || (lockActive && isReadOnly(s));
  const label = s.title ?? name;
  const desc = s.description as string | undefined;
  // Inline error for leaf fields: shown once touched or after a submit attempt.
  const err = validation.showAll || validation.touched.has(path) ? validation.errors.get(path) : undefined;
  const change = (v: unknown) => {
    validation.mark(path);
    onChange(v);
  };
  // Wrap nested (object/array/variant) renders so descendants inherit the lock.
  const sub = (node: React.ReactNode) => <LockedCtx.Provider value={locked}>{node}</LockedCtx.Provider>;

  if (s["ui:widget"] === "single" && s.type === "array")
    return sub(<SingleField name={name} schema={s} root={root} required={required} value={value} onChange={onChange} path={path} />);

  if (s.oneOf) return sub(<VariantField name={name} schema={s} root={root} required={required} value={value} onChange={onChange} path={path} />);

  if (s.enum) {
    return (
      <Select
        label={label}
        description={desc}
        isRequired={required}
        isDisabled={locked}
        errorText={err}
        hideLabel={hideLabel}
        selectedKey={value != null ? String(value) : (s.default != null ? String(s.default) : null)}
        onSelectionChange={(k) => change(coerceEnum(s.enum, k))}
        options={s.enum.map((e: unknown) => ({ id: String(e), label: String(e) }))}
      />
    );
  }

  switch (s.type) {
    case "boolean":
      return (
        <Checkbox label={label} isRequired={required} isDisabled={locked} isSelected={Boolean(value ?? s.default ?? false)} onChange={(v) => change(v)} />
      );
    case "number":
    case "integer":
      return (
        <TextField
          label={label}
          description={desc}
          isRequired={required}
          isDisabled={locked}
          errorText={err}
          hideLabel={hideLabel}
          type="number"
          value={value != null ? String(value) : ""}
          onChange={(v) => change(v === "" ? undefined : Number(v))}
        />
      );
    case "array":
      return sub(<ArrayField name={name} schema={s} root={root} required={required} value={value} onChange={onChange} path={path} />);
    case "object":
      if (s.properties)
        return sub(
          <Section label={label} desc={desc} required={required}>
            <ObjectFields
              schema={s}
              root={root}
              value={(value as Values) ?? {}}
              onChange={(v) => onChange(v)}
              view={s["ui:view"] as View | undefined}
              path={path}
            />
          </Section>,
        );
      if (s.additionalProperties && typeof s.additionalProperties === "object")
        return sub(<MapField name={name} label={label} desc={desc} value={value} onChange={onChange} />);
      return null;
    default:
      return (
        <TextField
          label={label}
          description={desc}
          isRequired={required}
          isDisabled={locked}
          errorText={err}
          hideLabel={hideLabel}
          placeholder={s.default != null ? String(s.default) : undefined}
          value={value != null ? String(value) : ""}
          onChange={(v) => change(v === "" ? undefined : v)}
        />
      );
  }
}

function coerceEnum(values: unknown[], key: string): unknown {
  const match = values.find((v) => String(v) === key);
  return match ?? key;
}

// Light section: heading + a thin left guide instead of a full bordered box,
// so deep nesting stays readable (no boxes-within-boxes).
function Section({
  label,
  desc,
  required,
  children,
}: {
  label: string;
  desc?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-sm font-semibold text-gray-700">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </div>
      {desc && <p className="mt-0.5 text-xs text-gray-500">{desc}</p>}
      <div className="mt-2 border-l-2 border-gray-100 pl-3">{children}</div>
    </div>
  );
}

// summarize builds a one-line preview for a collapsed array item from its first
// few primitive/enum fields (and array counts), skipping booleans.
function summarize(schema: Schema, value: unknown, root: Schema): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const v = value as Values;
  const parts: string[] = [];
  for (const k of orderedKeys(schema)) {
    if (parts.length >= 4) break;
    const ps = deref(schema.properties?.[k] ?? {}, root);
    const val = v[k];
    if (val == null || val === "") continue;
    if (ps.enum || ps.type === "string" || ps.type === "number" || ps.type === "integer") {
      parts.push(String(val));
    } else if (ps.type === "array" && Array.isArray(val) && val.length) {
      parts.push(`${ps.title ?? k}: ${val.length}`);
    }
  }
  return parts.join(" · ");
}

function VariantField({
  name,
  schema,
  root,
  required,
  value,
  onChange,
  path = "",
}: {
  name: string;
  schema: Schema;
  root: Schema;
  required?: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  path?: string;
}) {
  const locked = useContext(LockedCtx);
  const options: Schema[] = schema.oneOf.map((o: Schema) => deref(o, root));
  const sel = matchVariant(value, options, root);
  const selected = options[sel];
  return (
    <Section label={schema.title ?? name} desc={schema.description} required={required}>
      <div className="flex flex-col gap-3">
        <Select
          label="Вариант"
          isDisabled={locked}
          selectedKey={String(sel)}
          onSelectionChange={(k) => onChange(seedDefaults(options[Number(k)], root) ?? {})}
          options={options.map((o, i) => ({ id: String(i), label: o.title ?? `Вариант ${i + 1}` }))}
        />
        {selected.type === "object" && selected.properties ? (
          <ObjectFields schema={selected} root={root} value={(value as Values) ?? {}} onChange={onChange} path={path} />
        ) : (
          <Field name={name} schema={selected} root={root} required value={value} onChange={onChange} path={path} />
        )}
      </div>
    </Section>
  );
}

function ArrayField({
  name,
  schema,
  root,
  required,
  value,
  onChange,
  path = "",
}: {
  name: string;
  schema: Schema;
  root: Schema;
  required?: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  path?: string;
}) {
  const locked = useContext(LockedCtx);
  const items: unknown[] = Array.isArray(value) ? value : [];
  const itemSchema = deref(schema.items ?? {}, root);
  const isObjectItem = itemSchema.type === "object" && itemSchema.properties;
  const minItems = typeof schema.minItems === "number" ? schema.minItems : 0;
  // Can't remove below the schema minimum, and not at all when the array is locked.
  const noRemove = items.length <= minItems || locked;
  const removeHint = locked ? "Только для чтения" : "Нельзя удалить последний элемент";
  const update = (next: unknown[]) => onChange(next.length ? next : undefined);
  const setAt = (i: number, v: unknown) => update(items.map((x, idx) => (idx === i ? v : x)));
  const removeAt = (i: number) => {
    if (noRemove) return;
    update(items.filter((_, idx) => idx !== i));
  };

  return (
    <Section label={schema.title ?? name} desc={schema.description} required={required}>
      <div className="flex flex-col gap-2">
        {items.length === 0 && <p className="text-xs text-gray-400">Нет элементов.</p>}

        {items.map((it, i) =>
          isObjectItem ? (
            // Collapsible card with a one-line summary; collapsed by default.
            <Disclosure key={i} className="group rounded-md border border-gray-200 bg-surface">
              <div className="flex items-center gap-1 pr-1.5">
                <Heading className="min-w-0 flex-1">
                  <AriaButton
                    slot="trigger"
                    className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                  >
                    <IconChevronRight
                      size={16}
                      className="shrink-0 text-gray-400 transition-transform group-data-[expanded]:rotate-90"
                    />
                    <span className="truncate text-gray-800">
                      {summarize(itemSchema, it, root) || `Элемент ${i + 1}`}
                    </span>
                  </AriaButton>
                </Heading>
                <Hint text={noRemove ? removeHint : "Удалить"}>
                  <Button
                    variant="danger"
                    aria-label="Удалить"
                    className={noRemove ? "opacity-50" : ""}
                    onPress={() => !noRemove && removeAt(i)}
                  >
                    <IconTrash size={16} stroke={1.8} />
                  </Button>
                </Hint>
              </div>
              <DisclosurePanel>
                <div className="border-t border-gray-100 px-3 py-3">
                  <ObjectFields
                    schema={itemSchema}
                    root={root}
                    value={(it as Values) ?? {}}
                    onChange={(v) => setAt(i, v)}
                    view={schema["ui:view"] as View | undefined}
                    path={`${path}/${i}`}
                  />
                </div>
              </DisclosurePanel>
            </Disclosure>
          ) : (
            // Primitive item: a single label-less control + a remove button,
            // vertically centered so the button lines up with the input.
            <div key={i} className="flex items-center gap-2">
              <div className="flex-1">
                <Field
                  name={`${name}[${i}]`}
                  schema={itemSchema}
                  root={root}
                  required
                  value={it}
                  onChange={(v) => setAt(i, v)}
                  path={`${path}/${i}`}
                  hideLabel
                />
              </div>
              <Hint text={noRemove ? removeHint : "Удалить"}>
                <Button
                  variant="danger"
                  aria-label="Удалить"
                  className={noRemove ? "opacity-50" : ""}
                  onPress={() => !noRemove && removeAt(i)}
                >
                  <IconX size={16} stroke={2} />
                </Button>
              </Hint>
            </div>
          ),
        )}

        {!locked && (
          <div>
            <Button variant="secondary" onPress={() => update([...items, newArrayItem(schema, root)])}>
              + Добавить
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

// SingleField renders an array constrained to a single element as one object
// (no add/remove). The value stays a real array ([item]) so it still validates
// against the array schema (minItems:1 etc.) — the form just hides the list
// machinery. Used by views that cap a list to one, e.g. ordering one Gateway.
function SingleField({
  name,
  schema,
  root,
  required,
  value,
  onChange,
  path = "",
}: {
  name: string;
  schema: Schema;
  root: Schema;
  required?: boolean;
  value: unknown;
  onChange: (v: unknown) => void;
  path?: string;
}) {
  const itemSchema = deref(schema.items ?? {}, root);
  const item = Array.isArray(value) ? value[0] : undefined;
  const setItem = (v: unknown) => onChange(v === undefined ? undefined : [v]);
  const label = schema.title ?? name;
  const desc = schema.description as string | undefined;

  // Seed the item's schema defaults once when empty (e.g. default Gateway
  // resources). Unfilled fields are pruned on submit and a provided list
  // replaces the chart's values, so seeding is what makes a default effective.
  // Guarded to skip when a value already exists (e.g. editing a draft).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || item !== undefined) return;
    seeded.current = true;
    const def = seedDefaults(itemSchema, root) as Values | undefined;
    if (!def || typeof def !== "object") return;
    // Don't seed values for fields hidden by the view (e.g. hpa) — only visible defaults.
    for (const k of (schema["ui:view"] as View | undefined)?.exclude ?? []) delete def[k];
    if (Object.keys(def).length > 0) onChange([def]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item]);

  if (itemSchema.type === "object" && itemSchema.properties) {
    return (
      <Section label={label} desc={desc} required={required}>
        <ObjectFields
          schema={itemSchema}
          root={root}
          value={(item as Values) ?? {}}
          onChange={setItem}
          view={schema["ui:view"] as View | undefined}
          path={`${path}/0`}
        />
      </Section>
    );
  }
  return <Field name={name} schema={itemSchema} root={root} required value={item} onChange={setItem} path={`${path}/0`} />;
}

function MapField({
  label,
  desc,
  value,
  onChange,
}: {
  name: string;
  label: string;
  desc?: string;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const locked = useContext(LockedCtx);
  const init =
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.entries(value as Values).map(([k, v]) => ({ k, v: String(v) }))
      : [];
  const [rows, setRows] = useState<{ k: string; v: string }[]>(init);

  const push = (next: { k: string; v: string }[]) => {
    setRows(next);
    const obj: Values = {};
    for (const r of next) if (r.k) obj[r.k] = r.v;
    onChange(Object.keys(obj).length ? obj : undefined);
  };

  return (
    <Section label={label} desc={desc}>
      <div className="flex flex-col gap-2">
        {rows.length === 0 && <p className="text-xs text-gray-400">Нет записей.</p>}
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input
              disabled={locked}
              className="w-1/3 rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
              placeholder="ключ"
              value={r.k}
              onChange={(e) => push(rows.map((x, idx) => (idx === i ? { ...x, k: e.target.value } : x)))}
            />
            <input
              disabled={locked}
              className="flex-1 rounded-md border border-gray-300 px-2 py-1.5 text-sm outline-none focus:border-brand-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
              placeholder="значение"
              value={r.v}
              onChange={(e) => push(rows.map((x, idx) => (idx === i ? { ...x, v: e.target.value } : x)))}
            />
            <Button
              variant="danger"
              aria-label="Удалить"
              isDisabled={locked}
              onPress={() => push(rows.filter((_, idx) => idx !== i))}
            >
              <IconX size={16} stroke={2} />
            </Button>
          </div>
        ))}
        {!locked && (
          <div>
            <Button variant="secondary" onPress={() => push([...rows, { k: "", v: "" }])}>
              + Добавить
            </Button>
          </div>
        )}
      </div>
    </Section>
  );
}

// pruneEmpty removes undefined/"" leaves and empty objects so we don't submit
// blank values; arrays are preserved (with their object items pruned).
export function pruneEmpty(obj: Values): Values {
  return prune(obj) as Values;
}

function prune(v: any): any {
  if (Array.isArray(v)) return v.map(prune).filter((x) => x !== undefined && x !== "");
  if (v && typeof v === "object") {
    const out: Values = {};
    for (const [k, val] of Object.entries(v)) {
      const p = prune(val);
      if (p === undefined || p === "") continue;
      if (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length === 0) continue;
      out[k] = p;
    }
    return out;
  }
  return v;
}
