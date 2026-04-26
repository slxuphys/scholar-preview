/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

/** @type {{ docVersion: number, activeCellId?: string, notebookDir: string, cellOrder: string[], cellStateById: Record<string, any>, nodeById: Map<string, HTMLElement> }} */
const state = {
  docVersion: 0,
  activeCellId: undefined,
  notebookDir: "",
  cellOrder: [],
  cellStateById: {},
  nodeById: new Map()
};

const cellList = document.getElementById("cellList");
const emptyState = document.getElementById("emptyState");
const statusText = document.getElementById("statusText");
const refreshButton = document.getElementById("refreshButton");
const toggleFollowButton = document.getElementById("toggleFollowButton");
const openInBrowserButton = document.getElementById("openInBrowserButton");

refreshButton.addEventListener("click", () => {
  vscode.postMessage({ type: "requestFullSync" });
});

toggleFollowButton.addEventListener("click", () => {
  vscode.postMessage({ type: "toggleFollowActiveCell" });
});

openInBrowserButton.addEventListener("click", () => {
  vscode.postMessage({ type: "openInBrowser", renderedHtml: cellList.innerHTML });
});

window.addEventListener("message", (event) => {
  const message = event.data;

  if (message.type === "status") {
    statusText.textContent = message.text;
    return;
  }

  if (message.type === "setConfig") {
    window.__NOTEBOOK_PREVIEW_CONFIG__.followActiveCell = message.followActiveCell;
    toggleFollowButton.setAttribute("aria-pressed", String(message.followActiveCell));
    return;
  }

  if (message.type === "fullSync") {
    applyFullSync(message.snapshot, message.notebookDir ?? "");
    return;
  }

  if (message.type === "patch") {
    if (message.baseVersion !== state.docVersion) {
      vscode.postMessage({ type: "requestFullSync" });
      return;
    }

    applyPatch(message.ops, message.docVersion);
  }
});

function applyFullSync(snapshot, notebookDir) {
  state.docVersion = snapshot.docVersion;
  state.activeCellId = snapshot.activeCellId;
  state.notebookDir = notebookDir;
  state.cellOrder = [...snapshot.cellOrder];
  state.cellStateById = { ...snapshot.cells };

  state.nodeById.clear();
  cellList.innerHTML = "";

  for (const id of state.cellOrder) {
    const node = createCellNode(state.cellStateById[id]);
    state.nodeById.set(id, node);
    cellList.appendChild(node);
  }

  updateEmptyState();
  updateActiveVisual();
  renumberCrossRefs();
  vscode.postMessage({ type: "ack", docVersion: state.docVersion });
}

function applyPatch(ops, docVersion) {
  // Apply each operation without rebuilding unaffected cell DOM nodes.
  for (const op of ops) {
    switch (op.type) {
      case "insertCells":
        insertCells(op.at, op.cells);
        break;
      case "deleteCells":
        deleteCells(op.ids);
        break;
      case "moveCells":
        moveCells(op.ids, op.to);
        break;
      case "recordCellSnapshot":
        updateSingleCell(op.id, op.cell);
        break;
      case "setActiveCell": {
        const prevId = state.activeCellId;
        state.activeCellId = op.id;
        updateActiveVisual(prevId);
        break;
      }
      default:
        break;
    }
  }

  state.docVersion = docVersion;
  updateEmptyState();
  if (ops.some((op) => op.type !== "setActiveCell")) {
    renumberCrossRefs();
  }
  vscode.postMessage({ type: "ack", docVersion: state.docVersion });
}

function insertCells(at, cells) {
  let insertIndex = at;

  for (const cell of cells) {
    state.cellStateById[cell.id] = cell;
    state.cellOrder.splice(insertIndex, 0, cell.id);

    const node = createCellNode(cell);
    state.nodeById.set(cell.id, node);

    const anchorId = state.cellOrder[insertIndex + 1];
    const anchorNode = anchorId ? state.nodeById.get(anchorId) : null;

    if (anchorNode) {
      cellList.insertBefore(node, anchorNode);
    } else {
      cellList.appendChild(node);
    }

    insertIndex += 1;
  }
}

function deleteCells(ids) {
  for (const id of ids) {
    const index = state.cellOrder.indexOf(id);
    if (index >= 0) {
      state.cellOrder.splice(index, 1);
    }

    delete state.cellStateById[id];

    const node = state.nodeById.get(id);
    if (node) {
      node.remove();
      state.nodeById.delete(id);
    }
  }
}

function moveCells(ids, to) {
  const moving = [];

  for (const id of ids) {
    const index = state.cellOrder.indexOf(id);
    if (index >= 0) {
      state.cellOrder.splice(index, 1);
      moving.push(id);
    }
  }

  state.cellOrder.splice(to, 0, ...moving);

  const fragment = document.createDocumentFragment();
  for (const id of moving) {
    const node = state.nodeById.get(id);
    if (node) {
      fragment.appendChild(node);
    }
  }

  const anchorId = state.cellOrder[to + moving.length];
  const anchorNode = anchorId ? state.nodeById.get(anchorId) : null;

  if (anchorNode) {
    cellList.insertBefore(fragment, anchorNode);
  } else {
    cellList.appendChild(fragment);
  }
}

function updateSingleCell(id, nextCell) {
  const previous = state.cellStateById[id];
  if (!previous) {
    return;
  }

  state.cellStateById[id] = nextCell;

  const node = state.nodeById.get(id);
  if (!node) {
    return;
  }

  patchCellNode(node, previous, nextCell);
}

function createCellNode(cell) {
  const article = document.createElement("article");
  article.className = getCellClassName(cell);
  article.dataset.cellId = cell.id;

  const header = document.createElement("header");
  header.className = "cell-header";
  header.textContent = `${cell.kind.toUpperCase()} - ${cell.language}`;

  const body = document.createElement("div");
  body.className = "cell-body";
  body.innerHTML = renderCellBody(cell);

  const outputs = document.createElement("div");
  outputs.className = "cell-outputs";
  outputs.innerHTML = renderOutputs(cell.outputs, cell.kind === "code" ? parseFigureDirectives(cell.source) : null);

  article.appendChild(header);
  article.appendChild(body);
  article.appendChild(outputs);

  article.addEventListener("click", () => {
    vscode.postMessage({ type: "focusCell", id: cell.id });
  });

  return article;
}

function patchCellNode(node, previous, nextCell) {
  if (previous.kind !== nextCell.kind || previous.language !== nextCell.language) {
    const header = node.querySelector(".cell-header");
    header.textContent = `${nextCell.kind.toUpperCase()} - ${nextCell.language}`;
  }

  node.className = getCellClassName(nextCell);

  const sourceChanged = previous.source !== nextCell.source;
  const outputsChanged = JSON.stringify(previous.outputs) !== JSON.stringify(nextCell.outputs);

  if (sourceChanged) {
    node.querySelector(".cell-body").innerHTML = renderCellBody(nextCell);
  }

  // Re-render outputs if outputs changed, OR if source changed for a code cell
  // (because fig directives in the source affect how outputs are wrapped).
  if (outputsChanged || (sourceChanged && nextCell.kind === "code")) {
    const figDirectives = nextCell.kind === "code" ? parseFigureDirectives(nextCell.source) : null;
    node.querySelector(".cell-outputs").innerHTML = renderOutputs(nextCell.outputs, figDirectives);
  }
}

function renderCellBody(cell) {
  if (cell.kind === "markdown") {
    return renderMarkdownCell(cell.source || "");
  }

  if (!shouldRenderCodeSource(cell)) {
    return "";
  }

  const source = stripPreviewDirectiveLines(cell.source || "");
  const lang = cell.language || "";
  let codeHtml;
  /* global hljs */
  if (lang && typeof hljs !== "undefined" && hljs.getLanguage(lang)) {
    codeHtml = hljs.highlight(source, { language: lang, ignoreIllegals: true }).value;
  } else {
    codeHtml = escapeHtml(source);
  }
  return `<pre class="code-source"><code class="hljs">${codeHtml}</code></pre>`;
}

/**
 * Parse Quarto-style figure directives from code cell source.
 * Recognises '#| fig-cap: ...' and '#| fig-label: fig-*'.
 */
function parseFigureDirectives(source) {
  let cap = null;
  let label = null;
  for (const line of String(source || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    const capMatch = /^#\|\s*fig-cap\s*:\s*(.+)$/i.exec(trimmed);
    if (capMatch) { cap = capMatch[1].trim(); continue; }
    const labelMatch = /^#\|\s*fig-label\s*:\s*(fig-[a-z0-9_-]+)\s*$/i.exec(trimmed);
    if (labelMatch) { label = labelMatch[1]; }
  }
  return { cap, label };
}

function stripPreviewDirectiveLines(source) {
  return String(source || "")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#|"))
    .join("\n");
}

function getCellClassName(cell) {
  const classes = ["cell", `cell-${cell.kind}`];
  if (cell.kind === "code" && !shouldRenderCodeSource(cell)) {
    classes.push("cell-code-hidden-source");
  }
  return classes.join(" ");
}

function shouldRenderCodeSource(cell) {
  if (cell.kind !== "code") {
    return false;
  }

  // Default behavior: source is hidden unless explicitly enabled by directive.
  const echoDirective = getEchoDirective(cell.source || "");
  return echoDirective === "on";
}

function getEchoDirective(source) {
  const lines = String(source || "").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }

    const match = /^#\|\s*echo\s*:\s*(on|off)\s*$/i.exec(trimmed);
    return match ? match[1].toLowerCase() : undefined;
  }

  return undefined;
}

/**
 * Extract math tokens from raw source BEFORE any markdown or HTML processing.
 * Returns tokenized string plus arrays of the raw LaTeX for each token.
 */
function extractMathTokens(source) {
  const displayMaths = [];
  const inlineMaths = [];

  // Replace $$...$$ first (display math, may span lines).
  // Optionally capture a Quarto-style label tag: $$ ... $$ {#eq-label}
  let tokenized = source.replace(/\$\$([\s\S]+?)\$\$[ \t]*(?:\{#(eq-[a-z0-9_-]+)\})?/g, (_match, math, label) => {
    const idx = displayMaths.length;
    displayMaths.push({ math, label: label || null });
    return `KATEX_DISPLAY_${idx}`;
  });

  // Replace $...$ for inline math (no newlines inside)
  tokenized = tokenized.replace(/\$([^$\n]+?)\$/g, (_match, math) => {
    const idx = inlineMaths.length;
    inlineMaths.push(math);
    return `KATEX_INLINE_${idx}`;
  });

  return { tokenized, displayMaths, inlineMaths };
}

/**
 * Replace math tokens in the already-built HTML string with KaTeX-rendered HTML.
 * Display math gets a numbered wrapper; inline math is rendered inline.
 */
function restoreMathTokens(html, displayMaths, inlineMaths) {
  let out = html.replace(/KATEX_DISPLAY_(\d+)/g, (_match, idxStr) => {
    const entry = displayMaths[Number(idxStr)];
    if (!entry) { return _match; }
    try {
      // eslint-disable-next-line no-undef
      const rendered = katex.renderToString(entry.math, { displayMode: true, throwOnError: false });
      const labelAttr = entry.label ? ` id="${entry.label}" data-eq-label="${entry.label}"` : "";
      return `<div class="katex-display-eq"${labelAttr}><div class="katex-display-content">${rendered}</div><span class="eq-number"></span></div>`;
    } catch (e) {
      return `<div class="math-block-error">$$${escapeHtml(entry.math)}$$</div>`;
    }
  });

  out = out.replace(/KATEX_INLINE_(\d+)/g, (_match, idxStr) => {
    const math = inlineMaths[Number(idxStr)];
    if (math === undefined) { return _match; }
    try {
      // eslint-disable-next-line no-undef
      return katex.renderToString(math, { displayMode: false, throwOnError: false });
    } catch (e) {
      return `<span class="math-inline-error">$${escapeHtml(math)}$</span>`;
    }
  });

  return out;
}

/**
 * Walk all display-math wrappers and figure blocks in DOM order, assign sequential
 * numbers, build label maps, then resolve all cross-reference placeholders.
 */
function renumberCrossRefs() {
  // --- Sections ---
  // Counters for h1–h6; resetting lower levels when a higher level increments.
  const secCounters = [0, 0, 0, 0, 0, 0];
  const secLabelMap = new Map();

  for (const numEl of document.querySelectorAll(".sec-number[data-sec-level]")) {
    const level = parseInt(numEl.dataset.secLevel, 10);
    secCounters[level - 1]++;
    // Reset all deeper levels
    for (let i = level; i < 6; i++) { secCounters[i] = 0; }

    // Build dotted number string: only include levels up to current
    const numStr = secCounters.slice(0, level).join(".");
    numEl.textContent = numStr + "\u00a0\u00a0"; // trailing non-breaking spaces for gap

    const heading = numEl.closest("[data-sec-label]");
    if (heading) { secLabelMap.set(heading.dataset.secLabel, numStr); }
  }

  for (const ref of document.querySelectorAll(".sec-ref[data-sec-ref]")) {
    const label = ref.dataset.secRef;
    const num = secLabelMap.get(label);
    ref.textContent = num !== undefined ? `Section ${num}` : "Section ??";
    ref.href = num !== undefined ? `#${label}` : "";
  }

  // --- Equations ---
  const eqLabelMap = new Map();
  let eqN = 1;
  for (const el of document.querySelectorAll(".katex-display-eq")) {
    const numEl = el.querySelector(".eq-number");
    if (numEl) { numEl.textContent = `(${eqN})`; }
    const label = el.dataset.eqLabel;
    if (label) { eqLabelMap.set(label, eqN); }
    eqN++;
  }
  for (const ref of document.querySelectorAll(".eq-ref[data-eq-ref]")) {
    const label = ref.dataset.eqRef;
    const num = eqLabelMap.get(label);
    ref.textContent = num !== undefined ? `Eq. (${num})` : "Eq. (??)";
    ref.href = num !== undefined ? `#${label}` : "";
  }

  // --- Figures ---
  const figLabelMap = new Map();
  let figN = 1;
  for (const el of document.querySelectorAll(".md-figure")) {
    const numEl = el.querySelector(".fig-number");
    if (numEl) { numEl.textContent = String(figN); }
    const label = el.dataset.figLabel;
    if (label) { figLabelMap.set(label, figN); }
    figN++;
  }
  for (const ref of document.querySelectorAll(".fig-ref[data-fig-ref]")) {
    const label = ref.dataset.figRef;
    const num = figLabelMap.get(label);
    ref.textContent = num !== undefined ? `Fig. ${num}` : "Fig. ??";
    ref.href = num !== undefined ? `#${label}` : "";
  }

  // --- Citations ---
  const citeLabelMap = new Map(); // key → citation number
  for (const el of document.querySelectorAll(".cite-ref[data-cite-key]")) {
    const key = el.dataset.citeKey;
    if (!citeLabelMap.has(key)) {
      citeLabelMap.set(key, citeLabelMap.size + 1);
    }
    const num = citeLabelMap.get(key);
    el.textContent = `[${num}]`;
    // Link directly to the URL; ref list at bottom also has the link.
    if (key.startsWith("doi:")) {
      el.href = `https://doi.org/${key.slice(4)}`;
    } else {
      el.href = `https://arxiv.org/abs/${key.slice(6)}`;
    }
    el.target = "_blank";
    el.rel = "noopener noreferrer";
    el.title = key; // tooltip on hover
  }

  // Build / clear reference list
  const refList = document.getElementById("referenceList");
  if (refList) {
    if (citeLabelMap.size === 0) {
      refList.hidden = true;
      refList.innerHTML = "";
    } else {
      refList.hidden = false;
      const entries = [...citeLabelMap.entries()].sort((a, b) => a[1] - b[1]);
      refList.innerHTML = `<h2 class="ref-heading">References</h2>` +
        entries.map(([key, num]) => {
          let url, display;
          if (key.startsWith("doi:")) {
            const doi = key.slice(4);
            url = `https://doi.org/${doi}`;
            display = key;
          } else {
            const id = key.slice(6); // strip "arxiv:"
            url = `https://arxiv.org/abs/${id}`;
            display = `arXiv:${id}`;
          }
          return `<div class="ref-entry" id="cite-entry-${num}"><span class="ref-number">[${num}]</span>\u00a0<a class="ref-link" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(display)}</a></div>`;
        }).join("");
    }
  }
}

function renderMarkdownCell(source) {
  const { tokenized, displayMaths, inlineMaths } = extractMathTokens(source);
  const lines = tokenized.split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let listType = null;
  let listItems = [];
  let codeFence = false;
  let codeFenceLang = "";
  let codeLines = [];
  let blockquoteLines = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }

    const text = paragraph.join(" ").trim();
    // A paragraph that is only a display-math token should not be wrapped in <p>
    if (/^KATEX_DISPLAY_\d+$/.test(text)) {
      blocks.push(text);
    } else {
      blocks.push(`<p>${renderInlineMarkdown(text)}</p>`);
    }
    paragraph = [];
  };

  const flushList = () => {
    if (!listType || listItems.length === 0) {
      return;
    }

    const tag = listType === "ol" ? "ol" : "ul";
    const items = listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("");
    blocks.push(`<${tag}>${items}</${tag}>`);
    listType = null;
    listItems = [];
  };

  const flushBlockquote = () => {
    if (blockquoteLines.length === 0) {
      return;
    }

    const inner = blockquoteLines.map((line) => `<p>${renderInlineMarkdown(line)}</p>`).join("");
    blocks.push(`<blockquote>${inner}</blockquote>`);
    blockquoteLines = [];
  };

  const flushCodeFence = () => {
    if (!codeFence) {
      return;
    }

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

  for (const line of lines) {
    const fenceMatch = /^```(\S*)/.exec(line.trim());
    if (fenceMatch) {
      flushParagraph();
      flushList();
      flushBlockquote();

      if (codeFence) {
        flushCodeFence();
      } else {
        codeFence = true;
        codeFenceLang = fenceMatch[1] || "";
      }
      continue;
    }

    if (codeFence) {
      codeLines.push(line);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      flushList();
      flushBlockquote();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)(?:\s+\{#(sec-[a-z0-9_-]+)\})?\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const level = heading[1].length;
      const headingText = heading[2];
      const secLabel = heading[3] || null;
      const idAttr = secLabel ? ` id="${secLabel}" data-sec-label="${secLabel}"` : "";
      const numSpan = `<span class="sec-number" data-sec-level="${level}"></span>`;
      blocks.push(`<h${level}${idAttr}>${numSpan}${renderInlineMarkdown(headingText)}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushBlockquote();
      blocks.push("<hr />");
      continue;
    }

    const blockquote = /^>\s?(.*)$/.exec(line);
    if (blockquote) {
      flushParagraph();
      flushList();
      blockquoteLines.push(blockquote[1]);
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
      flushBlockquote();
      if (listType && listType !== "ol") {
        flushList();
      }
      listType = "ol";
      listItems.push(ordered[1]);
      continue;
    }

    const unordered = /^[-*+]\s+(.*)$/.exec(line);
    if (unordered) {
      flushParagraph();
      flushBlockquote();
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(unordered[1]);
      continue;
    }

    // Block figure: a line that is only an image, optionally with a label
    const blockFig = /^!\[([^\]]*)\]\(([^)]+?)\)(?:\{#(fig-[a-z0-9_-]+)\})?$/.exec(line.trim());
    if (blockFig) {
      flushParagraph();
      flushList();
      flushBlockquote();
      const alt = blockFig[1];
      const rawSrc = blockFig[2];
      const figLabel = blockFig[3] || null;
      const resolvedSrc = resolveImageSrc(escapeHtml(rawSrc));
      if (resolvedSrc) {
        if (alt) {
          const idAttr = figLabel ? ` id="${figLabel}" data-fig-label="${figLabel}"` : "";
          const captionHtml = `<figcaption><strong>Figure <span class="fig-number"></span>.</strong> ${escapeHtml(alt)}</figcaption>`;
          blocks.push(`<figure class="md-figure" role="group"${idAttr}><img class="md-image" src="${resolvedSrc}" alt="${escapeHtml(alt)}" />${captionHtml}</figure>`);
        } else {
          blocks.push(`<figure class="md-figure-decorative" role="presentation"><img class="md-image" src="${resolvedSrc}" alt="" /></figure>`);
        }
      } else {
        blocks.push(`<p>${escapeHtml(`![${alt}](${rawSrc})`)}</p>`);
      }
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushBlockquote();
  flushCodeFence();

  const rawHtml = blocks.join("");
  return `<div class="markdown-content">${restoreMathTokens(rawHtml, displayMaths, inlineMaths)}</div>`;
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+?)\*/g, "<em>$1</em>");
  // Images: ![alt](src) — must come before the link regex
  html = html.replace(/!\[([^\]]*)\]\(([^)]+?)\)/g, (_match, alt, src) => {
    const resolvedSrc = resolveImageSrc(src);
    if (!resolvedSrc) {
      return escapeHtml(`![${alt}](${src})`);
    }
    return `<img class="md-image" src="${resolvedSrc}" alt="${alt}" />`;
  });
  html = html.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_match, label, target) => {
    const safeTarget = sanitizeHref(target);
    return `<a href="${safeTarget}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  // Equation cross-references: @eq-label → placeholder resolved after renumbering
  html = html.replace(/@(eq-[a-z0-9_-]+)/g, (_match, label) => {
    return `<a class="eq-ref" data-eq-ref="${label}" href="#${label}">Eq. (??)</a>`;
  });
  // Figure cross-references: @fig-label → placeholder resolved after renumbering
  html = html.replace(/@(fig-[a-z0-9_-]+)/g, (_match, label) => {
    return `<a class="fig-ref" data-fig-ref="${label}" href="#${label}">Fig. ??</a>`;
  });
  // Section cross-references: @sec-label → placeholder resolved after renumbering
  html = html.replace(/@(sec-[a-z0-9_-]+)/g, (_match, label) => {
    return `<a class="sec-ref" data-sec-ref="${label}" href="#${label}">Section ??</a>`;
  });
  // DOI citations: @doi:10.xxxx/yyyy → numbered placeholder resolved after full DOM scan
  html = html.replace(/@doi:(10\.[^\s,;)\]}<>"]+)/g, (_match, doi) => {
    return `<a class="cite-ref" data-cite-key="doi:${escapeHtml(doi)}" href="#">[??]</a>`;
  });
  // arXiv citations: @arxiv:NNNN.NNNNN → numbered placeholder resolved after full DOM scan
  html = html.replace(/@arxiv:([0-9]{4}\.[0-9]{4,5}(?:v[0-9]+)?)/g, (_match, id) => {
    return `<a class="cite-ref" data-cite-key="arxiv:${escapeHtml(id)}" href="#">[??]</a>`;
  });
  return html;
}

function sanitizeHref(target) {
  const trimmed = String(target || "").trim();
  if (trimmed.startsWith("javascript:")) {
    return "#";
  }

  return escapeHtml(trimmed);
}

function resolveImageSrc(src) {
  // src is HTML-escaped; unescape for URL handling
  const raw = src
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  if (raw.startsWith("javascript:")) {
    return null;
  }

  // Absolute URLs (http/https/data) pass through as-is
  if (/^https?:\/\//i.test(raw) || raw.startsWith("data:")) {
    return escapeHtml(raw);
  }

  // Relative path: resolve against the notebook directory
  if (state.notebookDir) {
    try {
      return escapeHtml(new URL(raw, state.notebookDir + "/").href);
    } catch {
      return null;
    }
  }

  return null;
}

function renderOutputs(outputs, figDirectives) {
  if (!outputs || outputs.length === 0) {
    return "";
  }

  const { cap, label } = figDirectives || {};

  const hasImage = outputs.some((o) => o.dataUri);

  return outputs
    .filter((output) => {
      // Suppress text/plain repr (e.g. "<Figure size 640x480 with 1 Axes>")
      // when an image output is already present in the same cell.
      // stdout (print statements) are kept regardless.
      if (hasImage && output.mime === "text/plain" && !output.dataUri) {
        return false;
      }
      return true;
    })
    .map((output) => {
      if (output.dataUri) {
        const imgHtml = `<img class="md-image" src="${output.dataUri}" alt="${cap ? escapeHtml(cap) : "Notebook output"}" />`;
        if (cap) {
          const idAttr = label ? ` id="${label}" data-fig-label="${label}"` : "";
          const captionHtml = `<figcaption><strong>Figure <span class="fig-number"></span>.</strong> ${escapeHtml(cap)}</figcaption>`;
          return `<figure class="md-figure" role="group"${idAttr}>${imgHtml}${captionHtml}</figure>`;
        }
        return `<img class="cell-image" src="${output.dataUri}" alt="Notebook output" />`;
      }

      const safeText = escapeHtml(output.text || "");
      const mimeLabel = output.mime || "text/plain";
      const className = output.mime === "application/vnd.code.notebook.stderr" || output.mime === "application/vnd.code.notebook.error"
        ? "output-block output-error"
        : "output-block";

      return `<div class="${className}"><div class="output-mime">${escapeHtml(mimeLabel)}</div><pre>${safeText}</pre></div>`;
    })
    .join("");
}

function updateEmptyState() {
  const empty = state.cellOrder.length === 0;
  emptyState.style.display = empty ? "block" : "none";
  cellList.style.display = empty ? "none" : "grid";
}

function updateActiveVisual(previousActiveCellId) {
  if (previousActiveCellId !== undefined) {
    // Fast path: only the two changing nodes need updating.
    const oldNode = state.nodeById.get(previousActiveCellId);
    if (oldNode) { oldNode.classList.remove("active"); }
    const newNode = state.activeCellId !== undefined ? state.nodeById.get(state.activeCellId) : undefined;
    if (newNode) {
      newNode.classList.add("active");
      if (window.__NOTEBOOK_PREVIEW_CONFIG__?.followActiveCell) {
        newNode.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    }
    return;
  }

  // Full scan after fullSync or major patch.
  for (const [id, node] of state.nodeById.entries()) {
    if (id === state.activeCellId) {
      node.classList.add("active");
      if (window.__NOTEBOOK_PREVIEW_CONFIG__?.followActiveCell) {
        node.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    } else {
      node.classList.remove("active");
    }
  }
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
