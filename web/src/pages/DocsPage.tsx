import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconArrowLeft, IconBook, IconSearch } from "@tabler/icons-react";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Spinner } from "../components/ui";

const BASE = `${import.meta.env.BASE_URL}docs-content/`;

interface NavItem {
  id: string;
  title: string;
  section: string;
  text?: string; // page plain text, filled for the search index
}
interface NavSection {
  title: string;
  items: { id: string; title: string }[];
}
interface Heading {
  level: number;
  text: string;
  id: string;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

function parseNav(md: string): NavSection[] {
  const sections: NavSection[] = [];
  let cur: NavSection | null = null;
  for (const raw of md.split("\n")) {
    const sec = raw.match(/^##\s+(.+)/);
    const item = raw.match(/^\s*-\s*\[(.+?)\]\(([^)]+)\)/);
    if (sec) {
      cur = { title: sec[1].trim(), items: [] };
      sections.push(cur);
    } else if (item && cur) {
      cur.items.push({ title: item[1].trim(), id: item[2].trim().replace(/^#?\/?/, "") });
    }
  }
  return sections;
}

// Strip the inline markdown a heading may carry so the TOC shows plain text.
function stripInline(s: string): string {
  return s
    .replace(/\[(.+?)\]\([^)]*\)/g, "$1")
    .replace(/[*`_]/g, "")
    .trim();
}

// Transliterate Cyrillic to Latin for readable slugs. Indexed by code point
// (0x430..0x44f = а..я) to keep Cyrillic literals out of the source.
const RU_LATIN = [
  "a", "b", "v", "g", "d", "e", "zh", "z", "i", "y", "k", "l", "m", "n", "o", "p",
  "r", "s", "t", "u", "f", "h", "ts", "ch", "sh", "sch", "", "y", "", "e", "yu", "ya",
];

function slugify(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x451) out += "e"; // ё
    else if (code >= 0x430 && code <= 0x44f) out += RU_LATIN[code - 0x430];
    else if (/[a-z0-9]/.test(ch)) out += ch;
    else out += "-";
  }
  return out.replace(/-+/g, "-").replace(/^-+|-+$/g, "") || "section";
}

// Parse all headings (ignoring fenced code) with unique, readable slug ids.
function parseHeadings(md: string): Heading[] {
  const out: Heading[] = [];
  const used = new Set<string>();
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.+)/);
    if (!m) continue;
    const text = stripInline(m[2]);
    const base = slugify(text);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    out.push({ level: m[1].length, text, id });
  }
  return out;
}

function plain(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[(.+?)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`|=-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// GitHub-style alert boxes (> [!NOTE], > [!WARNING], ...). Colors use theme ramps.
const ALERT: Record<string, { label: string; box: string; title: string }> = {
  note: { label: "Заметка", box: "border-sky-200 bg-sky-50", title: "text-sky-700" },
  tip: { label: "Совет", box: "border-emerald-200 bg-emerald-50", title: "text-emerald-700" },
  important: { label: "Важно", box: "border-brand-300 bg-brand-50", title: "text-brand-700" },
  warning: { label: "Внимание", box: "border-amber-300 bg-amber-50", title: "text-amber-700" },
  caution: { label: "Осторожно", box: "border-red-200 bg-red-50", title: "text-red-700" },
};

// Minimal remark plugin: tag "> [!NOTE]" blockquotes with data-alert and strip
// the marker, so the blockquote component can render an alert box. No deps.
function remarkAlerts() {
  const walk = (node: any) => {
    if (!node || !Array.isArray(node.children)) return;
    for (const child of node.children) {
      if (child.type === "blockquote") {
        const para = child.children?.[0];
        const txt = para?.children?.[0];
        const m = para?.type === "paragraph" && txt?.type === "text"
          ? txt.value.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i)
          : null;
        if (m) {
          txt.value = txt.value.slice(m[0].length);
          child.data = child.data || {};
          child.data.hProperties = { ...(child.data.hProperties || {}), "data-alert": m[1].toLowerCase() };
        }
      }
      walk(child);
    }
  };
  return (tree: any) => walk(tree);
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => legacyCopy(text));
    return;
  }
  legacyCopy(text);
}

// Clipboard fallback for non-secure contexts (http on a hostname).
function legacyCopy(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* ignore: clipboard unavailable */
  }
  document.body.removeChild(ta);
}

// A "#" affordance on heading hover; clicking copies the section URL (does not navigate).
function HeadingAnchor({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        copyText(`${window.location.origin}${window.location.pathname}#${id}`);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
      aria-label="Скопировать ссылку на раздел"
      title={copied ? "Скопировано" : "Скопировать ссылку"}
      className={`ml-2 align-middle text-sm font-normal opacity-0 transition-opacity group-hover:opacity-100 ${
        copied ? "text-emerald-600 opacity-100" : "text-slate-300 hover:text-brand-500"
      }`}
    >
      {copied ? "✓" : "#"}
    </button>
  );
}

// Build the react-markdown element map: portal Tailwind styles. Every heading
// gets an id (in render order) and a "#" self-link; internal links route to /docs.
function makeComponents(headings: Heading[]): Components {
  let idx = 0;
  const nextId = () => headings[idx++]?.id ?? "section";
  return {
    h1: ({ node, children, ...p }) => {
      const id = nextId();
      return (
        <h1 id={id} className="group mb-4 scroll-mt-6 text-2xl font-semibold text-slate-900" {...p}>
          {children}
          <HeadingAnchor id={id} />
        </h1>
      );
    },
    h2: ({ node, children, ...p }) => {
      const id = nextId();
      return (
        <h2 id={id} className="group mt-10 mb-3 scroll-mt-6 border-t border-slate-200 pt-6 text-xl font-semibold text-slate-900" {...p}>
          {children}
          <HeadingAnchor id={id} />
        </h2>
      );
    },
    h3: ({ node, children, ...p }) => {
      const id = nextId();
      return (
        <h3 id={id} className="group mt-6 mb-2 scroll-mt-6 text-base font-semibold text-slate-800" {...p}>
          {children}
          <HeadingAnchor id={id} />
        </h3>
      );
    },
    h4: ({ node, children, ...p }) => {
      const id = nextId();
      return (
        <h4 id={id} className="group mt-4 mb-1 scroll-mt-6 text-sm font-semibold text-slate-700" {...p}>
          {children}
          <HeadingAnchor id={id} />
        </h4>
      );
    },
    p: ({ node, ...p }) => <p className="my-3 text-[15px] leading-relaxed text-slate-700" {...p} />,
    a: ({ node, href, ...p }) => {
      const cls = "font-semibold text-brand-600 transition-colors hover:text-brand-700";
      const ext = /^https?:/.test(href || "");
      if (ext) return <a href={href} target="_blank" rel="noreferrer" className={cls} {...p} />;
      const to = `/docs/${(href || "").replace(/^#?\/?/, "")}`;
      return <Link to={to} className={cls} {...p} />;
    },
    ul: ({ node, ...p }) => <ul className="my-3 ml-5 list-disc space-y-1.5 text-[15px] text-slate-700" {...p} />,
    ol: ({ node, ...p }) => <ol className="my-3 ml-5 list-decimal space-y-1.5 text-[15px] text-slate-700" {...p} />,
    li: ({ node, ...p }) => <li className="leading-relaxed" {...p} />,
    code: ({ node, ...p }) => <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800" {...p} />,
    pre: ({ node, ...p }) => (
      <pre
        className="my-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-[13px] leading-relaxed text-slate-100 [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-slate-100"
        {...p}
      />
    ),
    blockquote: ({ node, children, ...p }) => {
      const type = (p as Record<string, unknown>)["data-alert"] as string | undefined;
      const a = type ? ALERT[type] : undefined;
      if (a) {
        return (
          <div className={`my-4 rounded-r-md border-l-4 py-2 pl-4 pr-3 ${a.box}`}>
            <div className={`mb-1 text-sm font-semibold ${a.title}`}>{a.label}</div>
            <div className="text-[15px] text-slate-700">{children}</div>
          </div>
        );
      }
      return (
        <blockquote className="my-4 rounded-r-md border-l-4 border-slate-300 bg-slate-50 py-2 pl-4 pr-3 text-[15px] text-slate-600">
          {children}
        </blockquote>
      );
    },
    table: ({ node, ...p }) => (
      <div className="my-4 overflow-x-auto">
        <table className="w-full border-collapse text-[14px]" {...p} />
      </div>
    ),
    th: ({ node, ...p }) => <th className="border border-slate-200 bg-slate-50 px-3 py-2 text-left font-medium text-slate-700" {...p} />,
    td: ({ node, ...p }) => <td className="border border-slate-200 px-3 py-2 text-slate-700" {...p} />,
    hr: ({ node, ...p }) => <hr className="my-8 border-slate-200" {...p} />,
    strong: ({ node, ...p }) => <strong className="font-semibold text-slate-900" {...p} />,
    img: ({ node, ...p }) => <img className="my-3 max-w-full rounded-lg border border-slate-200" {...p} />,
  };
}

// Memoized so scroll-driven TOC highlighting doesn't re-parse the markdown.
const DocContent = memo(function DocContent({ content, headings }: { content: string; headings: Heading[] }) {
  const components = useMemo(() => makeComponents(headings), [headings]);
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkAlerts]} components={components}>
      {content}
    </ReactMarkdown>
  );
});

function DocToc({ toc, scrollRef }: { toc: Heading[]; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const [active, setActive] = useState<string>("");
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || toc.length === 0) return;
    const onScroll = () => {
      let current = toc[0].id;
      for (const h of toc) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top - root.getBoundingClientRect().top <= 80) current = h.id;
      }
      setActive(current);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [toc, scrollRef]);

  if (toc.length === 0) return <div />;
  return (
    <nav className="sticky top-0 hidden w-56 shrink-0 overflow-y-auto py-8 pl-4 xl:block">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">На этой странице</div>
      <ul className="border-l border-slate-200">
        {toc.map((h) => (
          <li key={h.id}>
            <a
              href={`#${h.id}`}
              onClick={(e) => {
                e.preventDefault();
                document.getElementById(h.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={`-ml-px block border-l-2 py-1 text-[13px] ${h.level === 3 ? "pl-6" : "pl-3"} ${
                active === h.id
                  ? "border-brand-500 font-medium text-brand-600"
                  : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {h.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function DocsNav({
  nav,
  activeId,
  index,
}: {
  nav: NavSection[];
  activeId: string;
  index: NavItem[];
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (q.length < 2) return null;
    return index
      .filter((p) => `${p.title} ${p.text ?? ""}`.toLowerCase().includes(q))
      .slice(0, 12);
  }, [q, index]);

  return (
    <nav className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-slate-200 bg-surface px-3 py-5">
      <div className="relative mb-4">
        <IconSearch size={16} className="pointer-events-none absolute left-2.5 top-2.5 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по документации..."
          className="w-full rounded-md border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2 text-sm outline-none focus:border-brand-500 focus:bg-surface"
        />
      </div>

      {results ? (
        <ul className="flex flex-col gap-0.5">
          {results.length === 0 && <li className="px-2 py-1.5 text-sm text-slate-400">Ничего не найдено</li>}
          {results.map((r) => (
            <li key={r.id}>
              <Link
                to={`/docs/${r.id}`}
                onClick={() => setQuery("")}
                className="block rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                <span className="font-medium text-slate-700">{r.title}</span>
                <span className="block text-xs text-slate-400">{r.section}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        nav.map((sec) => (
          <div key={sec.title} className="mb-4">
            <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{sec.title}</div>
            <ul className="flex flex-col gap-0.5">
              {sec.items.map((it) => (
                <li key={it.id}>
                  <Link
                    to={`/docs/${it.id}`}
                    aria-current={activeId === it.id ? "page" : undefined}
                    className="block rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-50 aria-[current=page]:bg-brand-50 aria-[current=page]:font-medium aria-[current=page]:text-brand-700"
                  >
                    {it.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
    </nav>
  );
}

export function DocsPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [nav, setNav] = useState<NavSection[]>([]);
  const [navError, setNavError] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [searchIndex, setSearchIndex] = useState<NavItem[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  const flat = useMemo<NavItem[]>(
    () => nav.flatMap((s) => s.items.map((it) => ({ ...it, section: s.title }))),
    [nav],
  );
  const activeId = slug || flat[0]?.id || "index";
  const entry = flat.find((p) => p.id === activeId);
  const headings = useMemo(() => (content ? parseHeadings(content) : []), [content]);
  const toc = useMemo(() => headings.filter((h) => h.level === 2 || h.level === 3), [headings]);

  // Load the navigation manifest once.
  useEffect(() => {
    fetchText(`${BASE}_nav.md`)
      .then((md) => setNav(parseNav(md)))
      .catch((e) => setNavError(String(e)));
  }, []);

  // Build a lightweight search index from all pages (after nav is known).
  useEffect(() => {
    if (flat.length === 0) return;
    let cancelled = false;
    Promise.all(
      flat.map(async (p) => ({ ...p, text: await fetchText(`${BASE}${p.id}.md`).then(plain).catch(() => "") })),
    ).then((idx) => {
      if (!cancelled) setSearchIndex(idx);
    });
    return () => {
      cancelled = true;
    };
  }, [flat]);

  // Load the current page; redirect bare /docs to the first entry.
  useEffect(() => {
    if (flat.length === 0) return;
    if (!slug) {
      navigate(`/docs/${flat[0].id}`, { replace: true });
      return;
    }
    setContent(null);
    fetchText(`${BASE}${activeId}.md`)
      .then(setContent)
      .catch(() => setContent(`# Страница не найдена\n\nДокумент \`${activeId}\` не существует.`));
    scrollRef.current?.scrollTo(0, 0);
  }, [slug, activeId, flat, navigate]);

  // Jump to a section when the page is opened with a "#section" hash.
  useEffect(() => {
    if (!content) return;
    const hash = window.location.hash.slice(1);
    if (hash) document.getElementById(hash)?.scrollIntoView({ block: "start" });
  }, [content]);

  const i = flat.findIndex((p) => p.id === activeId);
  const prev = i > 0 ? flat[i - 1] : null;
  const next = i >= 0 && i < flat.length - 1 ? flat[i + 1] : null;

  return (
    <div className="flex h-screen flex-col bg-app text-slate-800">
      {/* Standalone docs chrome: its own bar with a button back to the portal. */}
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-200 bg-surface px-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-600 text-on-accent">
            <IconBook size={20} stroke={1.8} />
          </span>
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-semibold text-slate-800">Документация</span>
            <span className="truncate text-[11px] text-slate-400">Managed Services</span>
          </div>
        </div>
        <Link
          to="/"
          className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-600 outline-none hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700 focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <IconArrowLeft size={16} stroke={1.8} />
          Портал
        </Link>
      </header>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {navError ? (
          <div className="p-6 text-sm text-red-600">Не удалось загрузить документацию: {navError}</div>
        ) : (
          <>
            <DocsNav nav={nav} activeId={activeId} index={searchIndex} />

            <div ref={scrollRef} className="min-w-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-6xl gap-8 px-8 py-8">
                <article className="min-w-0 flex-1">
                  <Breadcrumbs
                    className="mb-4"
                    items={[
                      { label: "Документация", to: "/docs" },
                      ...(entry ? [{ label: entry.section }, { label: entry.title }] : []),
                    ]}
                  />
                  {content === null ? (
                    <Spinner />
                  ) : (
                    <>
                      <DocContent content={content} headings={headings} />
                      <div className="mt-12 flex justify-between gap-4 border-t border-slate-200 pt-6">
                        {prev ? (
                          <Link
                            to={`/docs/${prev.id}`}
                            className="flex flex-1 flex-col rounded-lg border border-slate-200 px-4 py-3 hover:border-brand-400"
                          >
                            <span className="text-xs text-slate-400">Назад</span>
                            <span className="text-sm font-medium text-slate-700">{prev.title}</span>
                          </Link>
                        ) : (
                          <span className="flex-1" />
                        )}
                        {next ? (
                          <Link
                            to={`/docs/${next.id}`}
                            className="flex flex-1 flex-col items-end rounded-lg border border-slate-200 px-4 py-3 text-right hover:border-brand-400"
                          >
                            <span className="text-xs text-slate-400">Далее</span>
                            <span className="text-sm font-medium text-slate-700">{next.title}</span>
                          </Link>
                        ) : (
                          <span className="flex-1" />
                        )}
                      </div>
                    </>
                  )}
                </article>

                <DocToc toc={toc} scrollRef={scrollRef} />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
