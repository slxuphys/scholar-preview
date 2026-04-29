import * as fs from "fs";
import * as path from "path";
import { CellSnapshot, NotebookSnapshot, OutputSnapshot } from "./protocol";
import { bibKeyForDoi, bibKeyForArxiv } from "./bibFetch";

export interface CitationRef {
  type: "arxiv" | "doi";
  /** Raw ID as written by the user, e.g. "2604.24784" or "10.1103/PhysRevX.8.021013" */
  id: string;
  /** Sanitised BibTeX / Typst cite key, e.g. "arxiv_2604_24784" */
  key: string;
}

/** Scan all markdown cells in a snapshot for @arxiv:ID and @doi:ID citations. */
export function collectCitationKeys(snapshot: NotebookSnapshot): CitationRef[] {
  const seen = new Set<string>();
  const result: CitationRef[] = [];
  for (const id of snapshot.cellOrder) {
    const cell = snapshot.cells[id];
    if (!cell) { continue; }
    for (const m of cell.source.matchAll(/@(arxiv|doi):([^\s,;)\]"]+)/g)) {
      const type = m[1] as "arxiv" | "doi";
      const rawId = m[2];
      const key = type === "doi" ? bibKeyForDoi(rawId) : bibKeyForArxiv(rawId);
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ type, id: rawId, key });
      }
    }
  }
  return result;
}

/** Convert a notebook snapshot to Typst markup, writing image assets into tmpDir. */
export function snapshotToTypst(snapshot: NotebookSnapshot, tmpDir: string): string {
  const parts: string[] = [typstPreamble()];

  let frontMatterEmitted = false;

  for (const id of snapshot.cellOrder) {
    const cell = snapshot.cells[id];
    if (!cell) { continue; }

    if (cell.kind === "markdown") {
      // Extract YAML front matter from the very first markdown cell only
      if (!frontMatterEmitted) {
        frontMatterEmitted = true;
        const { frontMatter, rest } = splitFrontMatter(cell.source);
        if (frontMatter) {
          parts.push(frontMatterToTypst(frontMatter));
        }
        const converted = markdownToTypst(rest);
        if (converted.trim()) {
          parts.push(converted);
          parts.push("\n\n");
        }
        continue;
      }
      const converted = markdownToTypst(cell.source);
      if (converted.trim()) {
        parts.push(converted);
        parts.push("\n\n");
      }
    } else {
      if (!frontMatterEmitted) { frontMatterEmitted = true; }
      appendCodeCell(cell, id, tmpDir, parts);
    }
  }

  return parts.join("");
}

/** Split a markdown string into YAML front matter and the rest.
 *  Returns `frontMatter` as a key→value map if a `---` block is present. */
function splitFrontMatter(source: string): { frontMatter: Record<string, string> | null; rest: string } {
  const lines = source.split("\n");
  if (lines[0].trim() !== "---") {
    return { frontMatter: null, rest: source };
  }
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (closeIdx < 0) {
    return { frontMatter: null, rest: source };
  }
  const yamlLines = lines.slice(1, closeIdx);
  const rest = lines.slice(closeIdx + 1).join("\n");
  const frontMatter: Record<string, string> = {};
  for (const line of yamlLines) {
    const m = line.match(/^([\w-]+)\s*:\s*"?([^"]*)"?\s*$/);
    if (m) { frontMatter[m[1].toLowerCase().trim()] = m[2].trim(); }
  }
  return { frontMatter, rest };
}

/** Render a front matter map as a Typst title block. */
function frontMatterToTypst(fm: Record<string, string>): string {
  const parts: string[] = [];
  if (fm["title"]) {
    parts.push(`#align(center, text(size: 20pt, weight: "bold")[${escTypst(fm["title"])}])\n`);
  }
  if (fm["author"]) {
    parts.push(`#align(center, text(size: 13pt)[${escTypst(fm["author"])}])\n`);
  }
  if (fm["affiliation"]) {
    parts.push(`#align(center, text(size: 11pt, style: "italic")[${escTypst(fm["affiliation"])}])\n`);
  }
  if (fm["date"]) {
    parts.push(`#align(center, text(size: 11pt)[${escTypst(fm["date"])}])\n`);
  }
  if (parts.length > 0) {
    parts.push("#v(1.5em)\n");
  }
  return parts.join("");
}

/** Escape characters that are special in Typst markup content. */
function escTypst(s: string): string {
  return s.replace(/#/g, "\\#").replace(/@/g, "\\@").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function typstPreamble(): string {
  return `#import "@preview/mitex:0.2.5": *

#set page(
  paper: "a4",
  margin: (top: 2.5cm, bottom: 2.5cm, left: 2.5cm, right: 2.5cm),
  numbering: "1",
)
#set text(size: 11pt)
#set par(justify: true)
#set math.equation(
  numbering: "(1)",
  supplement: "Eq.",
)
#show ref: it => context {
  let elems = query(it.target)

  if elems.len() == 0 {
    it
  } else {
    let elem = elems.first()

    if elem.func() == math.equation {
      let n = counter(math.equation).at(elem.location()).at(0)
      [Eq.~#link(it.target)[(#n)]]
    } else if elem.func() == figure {
      let n = counter(figure).at(elem.location()).at(0)
      [Fig.~#link(it.target)[(#n)]]
    } else {
      it
    }
  }
}
#show link: set text(fill: blue, weight: 700)

#show raw.where(block: true): block.with(
  fill: luma(245),
  inset: (x: 8pt, y: 6pt),
  radius: 3pt,
  width: 100%,
)

`;
}

/** Parse Quarto #| key: value directives from a cell's source lines. */
function parseQuartoDirectives(source: string): Record<string, string> {
  const directives: Record<string, string> = {};
  for (const line of source.split("\n")) {
    const m = line.match(/^#\|\s*([\w-]+)\s*:\s*"?([^"]*)"?\s*$/);
    if (m) {
      directives[m[1].trim()] = m[2].trim();
    }
  }
  return directives;
}

function appendCodeCell(
  cell: CellSnapshot,
  cellId: string,
  tmpDir: string,
  parts: string[]
): void {
  const directives = parseQuartoDirectives(cell.source);
  // fig-cap / caption
  const caption = directives["fig-cap"] ?? "";
  // label: prefer "label", fall back to "fig-label"
  const rawLabel = directives["label"] ?? directives["fig-label"] ?? "";
  // Normalise: strip leading "fig-" if present so @fig-xxx works, keep as-is otherwise
  const label = rawLabel;

  // echo: defaults to true; suppress source when set to "false" or "off"
  const echoVal = (directives["echo"] ?? "true").toLowerCase();
  const echo = echoVal !== "false" && echoVal !== "off";
  if (echo && cell.source.trim()) {
    // Strip #| directive lines from the displayed source
    const displaySource = cell.source
      .split("\n")
      .filter(l => !/^#\|/.test(l))
      .join("\n")
      .trim();
    if (displaySource) {
      const lang = sanitizeLang(cell.language);
      const fence = chooseFence(displaySource);
      parts.push(`${fence}${lang}\n${displaySource}\n${fence}\n\n`);
    }
  }

  let imgIdx = 0;
  for (const out of cell.outputs) {
    if (out.dataUri) {
      const commaIdx = out.dataUri.indexOf(",");
      if (commaIdx < 0) { continue; }
      const base64 = out.dataUri.slice(commaIdx + 1);
      const ext =
        out.mime === "image/jpeg" ? "jpg" :
        out.mime === "image/svg+xml" ? "svg" : "png";
      const fname = `img_${safeId(cellId)}_${imgIdx}.${ext}`;
      fs.writeFileSync(path.join(tmpDir, fname), Buffer.from(base64, "base64"));

      const imgExpr = `image("${fname}", width: auto, height: auto)`;
      if (caption || label) {
        const captionPart = caption ? `,\n  caption: [${caption}]` : "";
        const labelPart = label ? ` <${label}>` : "";
        parts.push(`#figure(\n  ${imgExpr}${captionPart},\n)${labelPart}\n\n`);
      } else {
        parts.push(`#align(center)[#${imgExpr}]\n\n`);
      }
      imgIdx++;
    } else if (out.text) {
      const text = out.text.trimEnd();
      if (!text) { continue; }
      const isErr = out.mime.includes("stderr") || out.mime.includes("error");
      const fill = isErr ? `rgb("#fff0f0")` : `luma(252)`;
      const stroke = isErr ? `0.5pt + rgb("#ffbbbb")` : `0.5pt + luma(210)`;
      parts.push(
        `#block(fill: ${fill}, stroke: ${stroke}, inset: (x: 8pt, y: 6pt), radius: 3pt, width: 100%)[#raw(block: true, ${typstStr(text)})]\n\n`
      );
    }
  }
}

/** Pick the shortest backtick fence that doesn't appear in the code. */
function chooseFence(code: string): string {
  let n = 3;
  const m = code.match(/`+/g);
  if (m) {
    const max = Math.max(...m.map((s) => s.length));
    if (max >= n) { n = max + 1; }
  }
  return "`".repeat(n);
}

function sanitizeLang(lang: string): string {
  return /^[a-zA-Z0-9_+\-#]+$/.test(lang) ? lang : "";
}

function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 32);
}

/** Produce a Typst double-quoted string literal from a raw value. */
function typstStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── Markdown → Typst ─────────────────────────────────────────────────────────

export function markdownToTypst(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceMarker = "";
  let inDisplayMath = false;
  let mathLines: string[] = [];

  for (const line of lines) {
    // Inside a fenced code block — pass through verbatim
    if (inFence) {
      out.push(line);
      if (line.trimEnd() === fenceMarker) { inFence = false; }
      continue;
    }

    // Inside a display math block ($$...$$)
    if (inDisplayMath) {
      // Closing line: $$ optionally followed by a Quarto/Pandoc label {#id}
      const closeMatch = line.trim().match(/^\$\$(\s*\{#([^}]+)\})?\s*$/);
      if (closeMatch) {
        const label = closeMatch[2] ? ` <${closeMatch[2]}>` : "";
        out.push(`#mitex("${escLatex(mathLines.join("\n"))}")${label}\n`);
        mathLines = [];
        inDisplayMath = false;
      } else {
        mathLines.push(line);
      }
      continue;
    }

    // Opening fence
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)/);
    if (fenceMatch) {
      inFence = true;
      fenceMarker = fenceMatch[1][0].repeat(fenceMatch[1].length);
      out.push(line);
      continue;
    }

    // Display math on a single line: $$...$$ (not just $$)
    const singleDisplay = line.match(/^\s*\$\$(.+)\$\$\s*$/);
    if (singleDisplay) {
      out.push(`#mitex("${escLatex(singleDisplay[1].trim())}")\n`);
      continue;
    }

    // Opening $$ on its own line
    if (line.trim() === "$$") {
      inDisplayMath = true;
      mathLines = [];
      continue;
    }

    out.push(convertMarkdownLine(line));
  }

  // Unclosed display math block — emit whatever we have
  if (inDisplayMath && mathLines.length > 0) {
    out.push(`#mitex("${escLatex(mathLines.join("\n"))}")\n`);
  }

  return out.join("\n");
}

function convertMarkdownLine(line: string): string {
  // Heading
  const hm = line.match(/^(#{1,6})\s+(.*)/);
  if (hm) {
    return "=".repeat(hm[1].length) + " " + convertInline(hm[2]);
  }

  // Horizontal rule (3+ same chars: -, *, _)
  if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
    return "#line(length: 100%)";
  }

  // Blockquote
  if (line.startsWith("> ")) {
    return "#quote[" + convertInline(line.slice(2)) + "]";
  }
  if (line.trim() === ">") {
    return "";
  }

  // Unordered list item
  const ul = line.match(/^(\s*)[-*+]\s+(.*)/);
  if (ul) {
    return ul[1] + "- " + convertInline(ul[2]);
  }

  // Ordered list item
  const ol = line.match(/^(\s*)\d+[.)]\s+(.*)/);
  if (ol) {
    return ol[1] + "+ " + convertInline(ol[2]);
  }

  // Standalone image line: ![alt](src) or ![alt](src){#label width=80% fig-cap="..."}
  const standaloneImg = line.match(/^!\[([^\]]*)\]\(([^)]+)\)(\{[^}]*\})?\s*$/);
  if (standaloneImg) {
    const [, alt, src, attrs] = standaloneImg;
    const label = attrs?.match(/#([a-zA-Z][a-zA-Z0-9_-]*)/)?.[1];
    const capMatch = attrs?.match(/fig-cap(?:tion)?\s*=\s*"([^"]*)"/i);
    const caption = capMatch?.[1] ?? alt;
    const widthMatch = attrs?.match(/width\s*=\s*["']?([^"'\s}]+)["']?/i);
    const width = widthMatch ? widthMatch[1] : (label ? "100%" : "auto");
    // Typst expects a ratio for percentages: 80% → 80%  (valid Typst syntax)
    const widthExpr = width === "auto" ? "auto" : `${width}`;
    if (label) {
      const capTypst = caption ? `[${caption}]` : `[]`;
      return `#figure(image("${escStr(src)}", width: ${widthExpr}), caption: ${capTypst}) <${label}>`;
    }
    return `#align(center)[#image("${escStr(src)}", width: ${widthExpr})]`;
  }

  return convertInline(line);
}

function convertInline(text: string): string {
  // Use placeholders to protect code spans and math from further processing
  const tokens: string[] = [];
  const protect = (s: string): string => {
    const idx = tokens.length;
    tokens.push(s);
    return `\x00T${idx}\x00`;
  };

  let r = text;

  // Inline code: `...`
  r = r.replace(/`([^`]+)`/g, (_, c) => protect("`" + c + "`"));

  // Display math ($$...$$) — must come before inline math
  // Pass LaTeX content verbatim to mitex for rendering
  r = r.replace(/\$\$([^$]+)\$\$/g, (_, m) => protect(`#mitex("${escLatex(m.trim())}")`) );

  // Inline math ($...$)
  r = r.replace(/\$([^$\n]+)\$/g, (_, m) => protect(`#mi("${escLatex(m)}")`) );

  // Images: ![alt](url) — inline context; strip any trailing {#...} attribute
  r = r.replace(/!\[([^\]]*)\]\(([^)]+)\)(\{[^}]*\})?/g, (_, _alt, url) =>
    protect(`#image("${escStr(url)}")`)
  );

  // Links: [text](url)
  r = r.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, url) =>
    protect(`#link("${escStr(url)}")[${txt}]`)
  );

  // Bold+italic: ***...***
  r = r.replace(/\*\*\*([^*\n]+)\*\*\*/g, (_, t) => `*_${t}_*`);

  // Bold: **...** and __...__
  r = r.replace(/\*\*([^*\n]+)\*\*/g, (_, t) => `*${t}*`);
  r = r.replace(/__([^_\n]+)__/g, (_, t) => `*${t}*`);

  // Italic: *text* (not between word chars)
  r = r.replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, (_, t) => `_${t}_`);

  // Italic: _text_ (not between word chars)
  r = r.replace(/(?<!\w)_([^_\n]+)_(?!\w)/g, (_, t) => `_${t}_`);

  // Strikethrough: ~~text~~
  r = r.replace(/~~([^~\n]+)~~/g, (_, t) => `#strike[${t}]`);

  // Bibliography citations: @arxiv:ID or @doi:ID → safe Typst cite key (before generic @label)
  r = r.replace(/@(arxiv|doi):([^\s,;)\]"]+)/g, (_, type, rawId) => {
    const key = type === "doi" ? bibKeyForDoi(rawId) : bibKeyForArxiv(rawId);
    return protect(`@${key}`);
  });

  // Quarto/Pandoc cross-references: @label → Typst @label (protect before escaping)
  r = r.replace(/@([a-zA-Z][a-zA-Z0-9_-]*)/g, (_, label) => protect(`@${label}`));

  // Escape Typst-special # and @ in non-token segments
  r = r
    .split(/(\x00T\d+\x00)/)
    .map((seg, i) =>
      i % 2 === 0
        ? seg.replace(/#/g, "\\#").replace(/@/g, "\\@")
        : seg
    )
    .join("");

  // Restore tokens
  r = r.replace(/\x00T(\d+)\x00/g, (_, i) => tokens[parseInt(i, 10)]);

  return r;
}

function escStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Escape a LaTeX string for embedding in a Typst string literal. */
function escLatex(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
