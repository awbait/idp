import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

// Tailwind-styled element map so we don't depend on the typography plugin.
// `inline` strips block spacing so a single line (e.g. a changelog bullet) renders
// without paragraph margins.
function components(inline: boolean): Components {
  return {
    h1: (p) => <h1 className="mt-4 mb-2 text-lg font-semibold text-gray-900 first:mt-0" {...p} />,
    h2: (p) => <h2 className="mt-4 mb-2 text-base font-semibold text-gray-900 first:mt-0" {...p} />,
    h3: (p) => <h3 className="mt-3 mb-1 text-sm font-semibold text-gray-800 first:mt-0" {...p} />,
    h4: (p) => <h4 className="mt-3 mb-1 text-sm font-semibold text-gray-700 first:mt-0" {...p} />,
    p: (p) => (inline ? <span {...p} /> : <p className="my-2 text-sm leading-relaxed text-gray-700" {...p} />),
    a: (p) => <a className="text-brand-600 underline hover:text-brand-700" target="_blank" rel="noopener noreferrer" {...p} />,
    ul: (p) => <ul className="my-2 ml-5 list-disc space-y-1 text-sm text-gray-700" {...p} />,
    ol: (p) => <ol className="my-2 ml-5 list-decimal space-y-1 text-sm text-gray-700" {...p} />,
    li: (p) => <li className="leading-relaxed" {...p} />,
    code: (p) => (
      <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] text-gray-800" {...p} />
    ),
    pre: (p) => (
      <pre className="my-3 overflow-x-auto rounded-md bg-gray-900 p-3 text-xs leading-relaxed text-gray-100" {...p} />
    ),
    blockquote: (p) => (
      <blockquote className="my-2 border-l-4 border-gray-200 pl-3 text-sm italic text-gray-600" {...p} />
    ),
    table: (p) => (
      <div className="my-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm" {...p} />
      </div>
    ),
    th: (p) => <th className="border border-gray-200 bg-gray-50 px-2 py-1 text-left font-medium" {...p} />,
    td: (p) => <td className="border border-gray-200 px-2 py-1 text-gray-700" {...p} />,
    hr: (p) => <hr className="my-4 border-gray-200" {...p} />,
    strong: (p) => <strong className="font-semibold text-gray-900" {...p} />,
    img: (p) => <img className="my-2 max-w-full rounded" {...p} />,
  };
}

// Markdown renders GitHub-flavoured markdown (README, changelog lines, …) with
// our Tailwind styles. Pass `inline` for single-line snippets.
export function Markdown({ children, inline = false }: { children: string; inline?: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components(inline)}>
      {children}
    </ReactMarkdown>
  );
}
