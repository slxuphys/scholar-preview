/* global escapeHtml, resolveImageSrc, sanitizeHref, extractMathTokens, restoreMathTokens, hljs, parseFrontMatter */

/**
 * markdown-renderer.js — Enhanced markdown block & inline renderer.
 *
 * Loaded after main.js; overrides renderMarkdownCell and renderInlineMarkdown
 * defined there. Depends on helpers defined in main.js (escapeHtml,
 * resolveImageSrc, sanitizeHref, extractMathTokens, restoreMathTokens,
 * parseFrontMatter, hljs).
 *
 * New capabilities vs the baseline main.js versions:
 *   • GFM pipe tables  (| col | col |  with :---: alignment)
 *   • Nested / indented lists  (recursive indent-aware renderer)
 *   • Task-list items  (- [ ] / - [x]  →  disabled checkbox)
 *   • Strikethrough    (~~text~~  →  <del>)
 *   • Underscore bold  (__text__  →  <strong>, word-boundary-aware)
 *   • Underscore italic (_text_   →  <em>,     word-boundary-aware)
 *   • Hard line breaks (trailing two spaces  →  <br />)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Inline renderer
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
function renderInlineMarkdown(text) {
  let html = escapeHtml(text);

  // Code spans first — protect their contents from subsequent passes.
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");

  // Strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

  // Bold: **text** (asterisk)
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Bold: __text__ (underscore) — not mid-word
  html = html.replace(/(?<![a-zA-Z0-9_])__(.+?)__(?![a-zA-Z0-9_])/g, "<strong>$1</strong>");

  // Italic: *text* (asterisk)
  html = html.replace(/\*([^*\n]+?)\*/g, "<em>$1</em>");

  // Italic: _text_ (underscore) — not mid-word
  html = html.replace(/(?<![a-zA-Z0-9_])_([^_\n]+?)_(?![a-zA-Z0-9_])/g, "<em>$1</em>");

  // Images — must come before the generic link regex.
  html = html.replace(/!\[([^\]]*)\]\(([^)]+?)\)/g, (_m, alt, src) => {
    const resolved = resolveImageSrc(src);
    return resolved
      ? `<img class="md-image" src="${resolved}" alt="${alt}" />`
      : escapeHtml(`![${alt}](${src})`);
  });

  // Links
  html = html.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_m, label, target) =>
    `<a href="${sanitizeHref(target)}" target="_blank" rel="noreferrer">${label}</a>`);

  // Cross-references & citations
  html = html.replace(/@(eq-[a-z0-9_-]+)/g, (_m, l) =>
    `<a class="eq-ref" data-eq-ref="${l}" href="#${l}">Eq. (??)</a>`);
  html = html.replace(/@(fig-[a-z0-9_-]+)/g, (_m, l) =>
    `<a class="fig-ref" data-fig-ref="${l}" href="#${l}">Fig. ??</a>`);
  html = html.replace(/@(sec-[a-z0-9_-]+)/g, (_m, l) =>
    `<a class="sec-ref" data-sec-ref="${l}" href="#${l}">Section ??</a>`);
  html = html.replace(/@doi:(10\.[^\s,;)\]}<>"]+)/g, (_m, doi) =>
    `<a class="cite-ref" data-cite-key="doi:${escapeHtml(doi)}" href="#">[??]</a>`);
  html = html.replace(/@arxiv:([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)/g, (_m, id) =>
    `<a class="cite-ref" data-cite-key="arxiv:${escapeHtml(id)}" href="#">[??]</a>`);

  return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Block renderer
// ─────────────────────────────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
function renderMarkdownCell(source) {
  // Strip YAML front matter; the doc header is handled separately.
  const fm = parseFrontMatter(source);
  const bodySource = fm ? fm.rest : source;

  const { tokenized, displayMaths, inlineMaths } = extractMathTokens(bodySource);
  const lines = tokenized.split(/\r?\n/);

  const blocks = [];
  let paragraph   = [];  // raw (untrimmed) lines — preserves trailing spaces for hard breaks
  let listItems   = [];  // { indent, type, text, task?, checked? }
  let listType    = null; // top-level list type currently open ('ul' | 'ol' | null)
  let tableLines  = [];  // accumulated pipe-table lines
  let codeFence   = false;
  let codeFenceLang = "";
  let codeLines   = [];
  let blockquoteLines = [];

  // ── Nested list renderer ────────────────────────────────────────────────────
  /**
   * Recursively renders a slice of `listItems` starting at `start`
   * where every item's indent >= baseIndent.
   * Returns [html, nextIndex].
   */
  const renderListItems = (items, start, baseIndent) => {
    let i = start;
    let html = "";
    let tag = null;

    while (i < items.length) {
      const item = items[i];
      if (item.indent < baseIndent) { break; }

      if (item.indent === baseIndent) {
        if (tag === null) {
          tag = item.type;
          html += `<${tag}>`;
        }

        // Build list-item inner content.
        let liInner = "";
        if (item.task) {
          const chk = item.checked ? " checked=\"\"" : "";
          liInner += `<input type="checkbox" disabled${chk} class="task-checkbox" /> `;
        }
        liInner += renderInlineMarkdown(item.text);

        i++;
        // If next items are deeper, recurse for a sub-list.
        if (i < items.length && items[i].indent > baseIndent) {
          const [subHtml, newI] = renderListItems(items, i, items[i].indent);
          liInner += subHtml;
          i = newI;
        }

        const liClass = item.task ? " class=\"task-item\"" : "";
        html += `<li${liClass}>${liInner}</li>`;
      } else {
        // item.indent > baseIndent without a parent claim — skip (shouldn't happen).
        i++;
      }
    }

    if (tag) { html += `</${tag}>`; }
    return [html, i];
  };

  // ── Table helpers ───────────────────────────────────────────────────────────
  const parseTableCells = (line) => {
    const t = line.trim();
    const inner = t.startsWith("|") ? t.slice(1) : t;
    const cells = inner.split("|");
    if (cells[cells.length - 1].trim() === "") { cells.pop(); }
    return cells.map((c) => c.trim());
  };

  const isTableSeparator = (line) =>
    /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line.trim());

  // ── Flush helpers ───────────────────────────────────────────────────────────
  const flushParagraph = () => {
    if (paragraph.length === 0) { return; }

    // Split into segments at hard line breaks (trailing "  " on a line).
    const segments = [""];
    for (let i = 0; i < paragraph.length; i++) {
      const raw = paragraph[i];
      if (i > 0 && /  $/.test(paragraph[i - 1])) {
        segments.push(raw.trim());
      } else {
        segments[segments.length - 1] += (i === 0 ? "" : " ") + raw.trim();
      }
    }

    const fullText = segments
      .map((s) => renderInlineMarkdown(s.trim()))
      .join("<br />");

    // A paragraph containing only a display-math token should not be wrapped in <p>.
    if (/^KATEX_DISPLAY_\d+$/.test(fullText.trim())) {
      blocks.push(fullText.trim());
    } else {
      blocks.push(`<p>${fullText}</p>`);
    }
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) { return; }
    const baseIndent = Math.min(...listItems.map((it) => it.indent));
    const [html] = renderListItems(listItems, 0, baseIndent);
    blocks.push(html);
    listType = null;
    listItems = [];
  };

  const flushBlockquote = () => {
    if (blockquoteLines.length === 0) { return; }
    const inner = blockquoteLines
      .map((l) => `<p>${renderInlineMarkdown(l)}</p>`)
      .join("");
    blocks.push(`<blockquote>${inner}</blockquote>`);
    blockquoteLines = [];
  };

  const flushCodeFence = () => {
    if (!codeFence) { return; }
    const raw = codeLines.join("\n");
    let codeHtml;
    if (codeFenceLang && typeof hljs !== "undefined" && hljs.getLanguage(codeFenceLang)) {
      codeHtml = hljs.highlight(raw, { language: codeFenceLang, ignoreIllegals: true }).value;
    } else {
      codeHtml = escapeHtml(raw);
    }
    const langClass = codeFenceLang ? ` language-${escapeHtml(codeFenceLang)}` : "";
    blocks.push(`<pre class="markdown-code"><code class="hljs${langClass}">${codeHtml}</code></pre>`);
    codeFence = false;
    codeFenceLang = "";
    codeLines = [];
  };

  const flushTable = () => {
    if (tableLines.length === 0) { return; }

    // Need at least a header row + a separator row.
    if (tableLines.length < 2 || !isTableSeparator(tableLines[1])) {
      // Not a valid table — fall back to paragraph.
      tableLines.forEach((l) => paragraph.push(l));
      tableLines = [];
      flushParagraph();
      return;
    }

    // Parse column alignments from separator row.
    const alignments = parseTableCells(tableLines[1]).map((cell) => {
      const t = cell.trim();
      if (/^:-+:$/.test(t)) { return "center"; }
      if (/^-+:$/.test(t))  { return "right"; }
      return "";  // default (left)
    });

    const mkAlign = (ci) => alignments[ci] ? ` style="text-align:${alignments[ci]}"` : "";

    const headerCells = parseTableCells(tableLines[0]);
    const dataRows    = tableLines.slice(2).map(parseTableCells);

    const thead = headerCells
      .map((c, ci) => `<th${mkAlign(ci)}>${renderInlineMarkdown(c)}</th>`)
      .join("");

    const tbody = dataRows
      .map((row) =>
        "<tr>" + row.map((c, ci) => `<td${mkAlign(ci)}>${renderInlineMarkdown(c)}</td>`).join("") + "</tr>"
      )
      .join("");

    blocks.push(
      `<div class="markdown-table-wrap"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`
    );
    tableLines = [];
  };

  // ── Main line loop ──────────────────────────────────────────────────────────
  for (const line of lines) {
    // ── Code fence toggle ──
    const fenceMatch = /^```(\S*)/.exec(line.trim());
    if (fenceMatch) {
      flushParagraph(); flushList(); flushBlockquote(); flushTable();
      if (codeFence) {
        flushCodeFence();
      } else {
        codeFence = true;
        codeFenceLang = fenceMatch[1] || "";
      }
      continue;
    }

    if (codeFence) { codeLines.push(line); continue; }

    // ── Blank line ──
    if (line.trim() === "") {
      flushParagraph(); flushList(); flushBlockquote(); flushTable();
      continue;
    }

    // ── ATX Heading ──
    const heading = /^(#{1,6})\s+(.*?)(?:\s+\{#(sec-[a-z0-9_-]+)\})?\s*$/.exec(line);
    if (heading) {
      flushParagraph(); flushList(); flushBlockquote(); flushTable();
      const level = heading[1].length;
      const secLabel = heading[3] || null;
      const idAttr  = secLabel ? ` id="${secLabel}" data-sec-label="${secLabel}"` : "";
      const numSpan = `<span class="sec-number" data-sec-level="${level}"></span>`;
      blocks.push(`<h${level}${idAttr}>${numSpan}${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    // ── Horizontal rule ──
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushParagraph(); flushList(); flushBlockquote(); flushTable();
      blocks.push("<hr />");
      continue;
    }

    // ── Blockquote ──
    const blockquote = /^>\s?(.*)$/.exec(line);
    if (blockquote) {
      flushParagraph(); flushList(); flushTable();
      blockquoteLines.push(blockquote[1]);
      continue;
    }

    // ── Ordered list item (indent-aware) ──
    const orderedMatch = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    if (orderedMatch) {
      flushParagraph(); flushBlockquote(); flushTable();
      const indent = orderedMatch[1].length;
      if (listType && listType !== "ol" && indent === 0) { flushList(); }
      listType = "ol";
      listItems.push({ indent, type: "ol", text: orderedMatch[2] });
      continue;
    }

    // ── Unordered list item (indent-aware, task-list support) ──
    const unorderedMatch = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (unorderedMatch) {
      flushParagraph(); flushBlockquote(); flushTable();
      const indent = unorderedMatch[1].length;
      const rest   = unorderedMatch[2];
      const taskMatch = /^\[([  xX])\]\s+(.*)$/.exec(rest);
      if (listType && listType !== "ul" && indent === 0) { flushList(); }
      listType = "ul";
      if (taskMatch) {
        listItems.push({
          indent, type: "ul", text: taskMatch[2],
          task: true, checked: taskMatch[1].toLowerCase() === "x"
        });
      } else {
        listItems.push({ indent, type: "ul", text: rest });
      }
      continue;
    }

    // ── Block figure  ![alt](src){#fig-label} ──
    const blockFig = /^!\[([^\]]*)\]\(([^)]+?)\)(?:\{#(fig-[a-z0-9_-]+)\})?$/.exec(line.trim());
    if (blockFig) {
      flushParagraph(); flushList(); flushBlockquote(); flushTable();
      const alt      = blockFig[1];
      const rawSrc   = blockFig[2];
      const figLabel = blockFig[3] || null;
      const resolvedSrc = resolveImageSrc(escapeHtml(rawSrc));
      if (resolvedSrc) {
        if (alt) {
          const idAttr = figLabel ? ` id="${figLabel}" data-fig-label="${figLabel}"` : "";
          const caption = `<figcaption><strong>Figure <span class="fig-number"></span>.</strong> ${escapeHtml(alt)}</figcaption>`;
          blocks.push(`<figure class="md-figure" role="group"${idAttr}><img class="md-image" src="${resolvedSrc}" alt="${escapeHtml(alt)}" />${caption}</figure>`);
        } else {
          blocks.push(`<figure class="md-figure-decorative" role="presentation"><img class="md-image" src="${resolvedSrc}" alt="" /></figure>`);
        }
      } else {
        blocks.push(`<p>${escapeHtml(`![${alt}](${rawSrc})`)}</p>`);
      }
      continue;
    }

    // ── Pipe table row (contains "|" and is not already consumed above) ──
    if (/\|/.test(line)) {
      flushParagraph(); flushList(); flushBlockquote();
      tableLines.push(line);
      continue;
    }

    // ── Default: paragraph accumulation (raw, to preserve trailing spaces) ──
    // Flush any open list before starting a paragraph — without a blank line
    // separator a plain line following list items must still appear after them.
    flushList(); flushBlockquote(); flushTable();
    paragraph.push(line);
  }

  // ── End-of-source flush ──
  flushParagraph();
  flushList();
  flushBlockquote();
  flushCodeFence();
  flushTable();

  const rawHtml = blocks.join("");
  return `<div class="markdown-content">${restoreMathTokens(rawHtml, displayMaths, inlineMaths)}</div>`;
}
