// A small Markdown renderer for release notes (the GitHub release body as
// carried in latest.json). It builds React elements only, never HTML, so a
// release body cannot inject markup. Links render as text with their address:
// the control window must not navigate away, and opening arbitrary URLs is
// not something the panel can do.
import { Fragment } from "react";

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/;

/** Inline code, bold, italic and links inside one block of text. */
export function renderInline(text, keyPrefix = "i") {
  const out = [];
  let rest = text;
  let index = 0;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) { out.push(rest); break; }
    if (match.index) out.push(rest.slice(0, match.index));
    const [token, code, bold, link] = match;
    const key = `${keyPrefix}-${index++}`;
    if (code) out.push(<code key={key}>{code.slice(1, -1)}</code>);
    else if (bold) out.push(<strong key={key}>{renderInline(bold.slice(2, -2), key)}</strong>);
    else if (link) {
      const [, label, url] = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(link);
      out.push(<Fragment key={key}>{renderInline(label, key)}{label === url ? "" : ` (${url})`}</Fragment>);
    } else out.push(<em key={key}>{renderInline(token.slice(1, -1), key)}</em>);
    rest = rest.slice(match.index + token.length);
  }
  return out;
}

/** Headings, bullet and numbered lists, code blocks and paragraphs. */
export function Markdown({ text }) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) { blocks.push(code); code = null; } else code.lines.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) { flushParagraph(); flushList(); code = { type: "code", lines: [] }; continue; }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      blocks.push({ type: "h", level: heading[1].length, text: heading[2] });
    } else if (bullet || numbered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (list?.type !== type) { flushList(); list = { type, items: [] }; }
      list.items.push((bullet || numbered)[1]);
    } else if (!line.trim()) {
      flushParagraph(); flushList();
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  if (code) blocks.push(code);
  flushParagraph();
  flushList();

  return (
    <div className="markdown">
      {blocks.map((block, i) => {
        const key = `b${i}`;
        if (block.type === "h") {
          // Release notes sit under the section's own headings: start at h4.
          const Tag = `h${Math.min(6, block.level + 3)}`;
          return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
        }
        if (block.type === "ul" || block.type === "ol") {
          const Tag = block.type;
          return <Tag key={key}>{block.items.map((item, j) => <li key={j}>{renderInline(item, `${key}-${j}`)}</li>)}</Tag>;
        }
        if (block.type === "code") return <pre key={key} className="log">{block.lines.join("\n")}</pre>;
        return <p key={key}>{renderInline(block.text, key)}</p>;
      })}
    </div>
  );
}
