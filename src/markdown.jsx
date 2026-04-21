import React from 'react';

// Minimal markdown → React-element renderer.
//
// Scope: **bold**, *italic*, `inline code`, [label](url), ordered + unordered
// lists, ATX headings (# … ######), paragraphs with line breaks, and horizontal
// rules. Deliberately narrow — no tables, no block code fences, no nested
// lists. We never use dangerouslySetInnerHTML, so the output is XSS-safe by
// construction.

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
function groupBlocks(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let current = null;

  const flush = () => {
    if (current) {
      blocks.push(current);
      current = null;
    }
  };

  for (const line of lines) {
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

export function renderMarkdown(text, keyPrefix = "md") {
  const blocks = groupBlocks(text);
  return blocks.map((b, bi) => {
    const bk = `${keyPrefix}-${bi}`;
    if (b.type === "hr") return <hr key={bk} style={HR_STYLE} />;
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
