import { Fragment, type ReactNode } from "react";

/** Inline: **bold** and `code`. Renders as React nodes, never as HTML. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i} className="rounded bg-surface-2 px-1 py-0.5 text-[0.85em]">{part.slice(1, -1)}</code>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

/** A small, safe Markdown renderer for AI reports: headings, lists, tables, paragraphs. */
export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r/g, "").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const cls = h[1].length <= 2 ? "mt-4 text-base font-semibold" : "mt-3 text-sm font-semibold";
      out.push(<p key={i} className={cls}>{inline(h[2])}</p>);
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*([-*]|\d+[.)])\s+/, ""));
        i++;
      }
      const L = ordered ? "ol" : "ul";
      out.push(
        <L key={i} className={`mt-2 space-y-1 ps-5 ${ordered ? "list-decimal" : "list-disc"}`}>
          {items.map((t, j) => <li key={j}>{inline(t)}</li>)}
        </L>,
      );
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      out.push(
        <div key={i} className="mt-2 overflow-x-auto">
          <table className="w-full text-xs">
            <tbody className="divide-y divide-border">
              {rows.map((r, j) => (
                <tr key={j} className={j === 0 ? "font-semibold" : ""}>
                  {r.map((c, k) => <td key={k} className="px-2 py-1 align-top">{inline(c)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|\s*[-*]\s|\s*\d+[.)]\s|\s*\|)/.test(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    if (!para.length) para.push(lines[i++]); // never stall on an unrecognised line
    out.push(<p key={i} className="mt-2">{inline(para.join(" "))}</p>);
  }
  return <div dir="auto" className="text-sm leading-relaxed [&>*:first-child]:mt-0">{out}</div>;
}
