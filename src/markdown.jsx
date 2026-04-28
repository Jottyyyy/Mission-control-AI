import React from 'react';
import { GOOGLE_FENCE_RENDERERS } from './GoogleRenderers.jsx';

// Minimal markdown → React-element renderer.
//
// Scope: **bold**, *italic*, `inline code`, [label](url), ordered + unordered
// lists, ATX headings (# … ######), paragraphs with line breaks, horizontal
// rules, and triple-backtick code fences. Fences whose language tag matches
// a `google-*` renderer (v1.23) are dispatched to a custom React component;
// other fences fall back to a styled <pre><code>. Deliberately narrow — no
// tables, no nested lists. We never use dangerouslySetInnerHTML, so the
// output is XSS-safe by construction.

const CODE_STYLE = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.88em",
  padding: "1px 5px",
  borderRadius: 4,
  background: "var(--bg-elev)",
  color: "var(--fg)",
};

const LINK_STYLE = {
  color: "var(--accent)",
  textDecoration: "underline",
};

// --- Inline pass -----------------------------------------------------------
// Order of alternations matters: bold (**x**) must win over italic (*x*)
// because the opening marker is longer. Code spans swallow their content so
// emphasis inside them stays literal.
function parseInline(text, keyPrefix = "") {
  if (text == null) return [];
  if (typeof text !== "string") return [text];
  const nodes = [];
  let i = 0;
  const re = /(\*\*[^\n][^\n]*?\*\*)|(`[^`\n]+`)|(\*[^\s*][^\n*]*?\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > i) nodes.push(text.slice(i, m.index));
    const token = m[0];
    const key = `${keyPrefix}-${m.index}`;
    if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{parseInline(token.slice(2, -2), key)}</strong>);
    } else if (token.startsWith("`")) {
      nodes.push(<code key={key} style={CODE_STYLE}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{parseInline(token.slice(1, -1), key)}</em>);
    } else if (token.startsWith("[")) {
      const mm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (mm) {
        nodes.push(
          <a
            key={key}
            href={mm[2]}
            target="_blank"
            rel="noopener noreferrer"
            style={LINK_STYLE}
          >
            {parseInline(mm[1], key)}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    i = m.index + token.length;
  }
  if (i < text.length) nodes.push(text.slice(i));
  return nodes;
}

// --- Block pass ------------------------------------------------------------
// Line-oriented: walk once, grouping contiguous list lines together and
// flushing on a type change or blank separator.
//
// Fences (``` ... ```) are matched as a single block — the opener carries the
// optional language tag (e.g. ```google-calendar-events) and content lines are
// captured verbatim until the closing ``` is seen. Unterminated fences swallow
// the rest of the message rather than corrupting downstream blocks.
function groupBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let current = null;
  let fence = null; // { lang, body[] }

  const flush = () => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    if (fence) {
      // Inside a fence: only the closing ``` ends it. Whitespace-only lines
      // are kept as-is so the JSON payload's pretty-printing survives.
      if (/^```\s*$/.test(line)) {
        blocks.push({ type: "fence", lang: fence.lang, body: fence.body.join("\n") });
        fence = null;
      } else {
        fence.body.push(line);
      }
      continue;
    }
    const fenceOpen = /^```([\w-]*)\s*$/.exec(line);
    if (fenceOpen) {
      flush();
      fence = { lang: fenceOpen[1] || "", body: [] };
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const h = /^(#{1,6}) +(.*)$/.exec(line);
    const hr = /^-{3,}\s*$/.test(line) || /^\*{3,}\s*$/.test(line);
    const ul = /^\s*[-*] +(.*)$/.exec(line);
    const ol = /^\s*\d+\. +(.*)$/.exec(line);
    if (hr) {
      flush();
      blocks.push({ type: "hr" });
    } else if (h) {
      flush();
      blocks.push({ type: "heading", level: h[1].length, text: h[2] });
    } else if (ul) {
      if (!current || current.type !== "ul") { flush(); current = { type: "ul", items: [] }; }
      current.items.push(ul[1]);
    } else if (ol) {
      if (!current || current.type !== "ol") { flush(); current = { type: "ol", items: [] }; }
      current.items.push(ol[1]);
    } else {
      if (!current || current.type !== "p") { flush(); current = { type: "p", lines: [] }; }
      current.lines.push(line);
    }
  }
  if (fence) {
    // Unterminated fence — treat what we have as a plain code block so the
    // user still sees the content rather than nothing.
    blocks.push({ type: "fence", lang: fence.lang, body: fence.body.join("\n") });
  }
  flush();
  return blocks;
}

const HEADING_STYLES = {
  1: { fontSize: 22, fontWeight: 600, margin: "18px 0 8px", color: "var(--fg)" },
  2: { fontSize: 18, fontWeight: 600, margin: "16px 0 6px", color: "var(--fg)" },
  3: { fontSize: 15, fontWeight: 600, margin: "14px 0 6px", color: "var(--fg)" },
  4: { fontSize: 14, fontWeight: 600, margin: "12px 0 4px", color: "var(--fg)" },
  5: { fontSize: 13, fontWeight: 600, margin: "10px 0 4px", color: "var(--fg)" },
  6: { fontSize: 13, fontWeight: 600, margin: "10px 0 4px", color: "var(--fg-muted)" },
};

const P_STYLE = { margin: "6px 0", lineHeight: 1.6, color: "var(--fg)" };
const UL_STYLE = { margin: "6px 0 6px 22px", padding: 0, listStyle: "disc", lineHeight: 1.6, color: "var(--fg)" };
const OL_STYLE = { margin: "6px 0 6px 22px", padding: 0, listStyle: "decimal", lineHeight: 1.6, color: "var(--fg)" };
const HR_STYLE = { border: 0, borderTop: "1px solid var(--border)", margin: "14px 0" };

const PRE_STYLE = {
  margin: "8px 0",
  padding: "10px 12px",
  background: "var(--bg-soft)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 12.5,
  lineHeight: 1.5,
  color: "var(--fg)",
  overflowX: "auto",
  whiteSpace: "pre",
};

// Cache JSON.parse results by the raw body string so identical payloads
// produce identical object references across re-renders. Without this,
// every parent re-render (e.g. on chat keystroke) produces a fresh data
// object, which defeats the React.memo'd renderers and causes flicker.
const FENCE_PARSE_CACHE = new Map();

function parseFenceBody(body) {
  if (FENCE_PARSE_CACHE.has(body)) return FENCE_PARSE_CACHE.get(body);
  const parsed = JSON.parse(body);
  // Bound the cache so a long-running session can't grow it without limit.
  if (FENCE_PARSE_CACHE.size > 256) {
    const firstKey = FENCE_PARSE_CACHE.keys().next().value;
    FENCE_PARSE_CACHE.delete(firstKey);
  }
  FENCE_PARSE_CACHE.set(body, parsed);
  return parsed;
}

function FenceRenderer({ Renderer, body }) {
  // useMemo is belt-and-braces over the module-level cache: it pins the
  // parsed reference for this component instance even if the cache evicts.
  const data = React.useMemo(() => parseFenceBody(body), [body]);
  return <Renderer data={data} />;
}

function renderFence(block, key) {
  const { lang, body } = block;
  const Renderer = GOOGLE_FENCE_RENDERERS[lang];
  if (Renderer) {
    try {
      // Validate parseability before mounting, so a bad payload falls back
      // to <pre><code> instead of throwing inside the renderer.
      parseFenceBody(body);
      return <FenceRenderer key={key} Renderer={Renderer} body={body} />;
    } catch {
      // Malformed JSON — fall through to plain code rendering rather than
      // throwing in the chat surface.
    }
  }
  return (
    <pre key={key} style={PRE_STYLE}>
      <code>{body}</code>
    </pre>
  );
}

export function renderMarkdown(text, keyPrefix = "md") {
  const blocks = groupBlocks(text);
  return blocks.map((b, bi) => {
    const bk = `${keyPrefix}-${bi}`;
    if (b.type === "hr") return <hr key={bk} style={HR_STYLE} />;
    if (b.type === "fence") return renderFence(b, bk);
    if (b.type === "heading") {
      const Tag = `h${b.level}`;
      return (
        <Tag key={bk} style={HEADING_STYLES[b.level]}>
          {parseInline(b.text, bk)}
        </Tag>
      );
    }
    if (b.type === "ul") {
      return (
        <ul key={bk} style={UL_STYLE}>
          {b.items.map((it, i) => (
            <li key={i}>{parseInline(it, `${bk}-${i}`)}</li>
          ))}
        </ul>
      );
    }
    if (b.type === "ol") {
      return (
        <ol key={bk} style={OL_STYLE}>
          {b.items.map((it, i) => (
            <li key={i}>{parseInline(it, `${bk}-${i}`)}</li>
          ))}
        </ol>
      );
    }
    return (
      <p key={bk} style={P_STYLE}>
        {b.lines.map((line, i) => (
          <React.Fragment key={i}>
            {parseInline(line, `${bk}-${i}`)}
            {i < b.lines.length - 1 && <br />}
          </React.Fragment>
        ))}
      </p>
    );
  });
}

export default renderMarkdown;
