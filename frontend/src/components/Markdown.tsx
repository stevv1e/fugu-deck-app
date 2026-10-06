import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as any).props.children);
  return "";
}

function Pre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <pre>
      <button
        className="copy-btn"
        onClick={() => {
          navigator.clipboard?.writeText(textOf(children));
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
      >
        {copied ? "ok" : "copy"}
      </button>
      {children}
    </pre>
  );
}

const plugins = { remark: [remarkGfm], rehype: [[rehypeHighlight, { detect: true, ignoreMissing: true }]] as any };

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={plugins.remark}
        rehypePlugins={plugins.rehype}
        components={{
          pre: Pre,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
