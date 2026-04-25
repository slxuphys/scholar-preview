/* global acquireVsCodeApi */

const vscode = acquireVsCodeApi();

/** @type {{ docVersion: number, activeCellId?: string, cellOrder: string[], cellStateById: Record<string, any>, nodeById: Map<string, HTMLElement> }} */
const state = {
  docVersion: 0,
  activeCellId: undefined,
  cellOrder: [],
  cellStateById: {},
  nodeById: new Map()
};

const cellList = document.getElementById("cellList");
const emptyState = document.getElementById("emptyState");
const statusText = document.getElementById("statusText");
const refreshButton = document.getElementById("refreshButton");
const toggleFollowButton = document.getElementById("toggleFollowButton");

refreshButton.addEventListener("click", () => {
  vscode.postMessage({ type: "requestFullSync" });
});

toggleFollowButton.addEventListener("click", () => {
  vscode.postMessage({ type: "toggleFollowActiveCell" });
});

window.addEventListener("message", (event) => {
  const message = event.data;

  if (message.type === "status") {
    statusText.textContent = message.text;
    return;
  }

  if (message.type === "fullSync") {
    applyFullSync(message.snapshot);
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

function applyFullSync(snapshot) {
  state.docVersion = snapshot.docVersion;
  state.activeCellId = snapshot.activeCellId;
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
  renumberEquations();
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
      case "setActiveCell":
        state.activeCellId = op.id;
        updateActiveVisual();
        break;
      default:
        break;
    }
  }

  state.docVersion = docVersion;
  updateEmptyState();
  renumberEquations();
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
  outputs.innerHTML = renderOutputs(cell.outputs);

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

  if (previous.source !== nextCell.source) {
    const body = node.querySelector(".cell-body");
    body.innerHTML = renderCellBody(nextCell);
  }

  if (JSON.stringify(previous.outputs) !== JSON.stringify(nextCell.outputs)) {
    const outputs = node.querySelector(".cell-outputs");
    outputs.innerHTML = renderOutputs(nextCell.outputs);
  }
}

function renderCellBody(cell) {
  if (cell.kind === "markdown") {
    return renderMarkdownCell(cell.source || "");
  }

  if (!shouldRenderCodeSource(cell)) {
    return "";
  }

  const escaped = escapeHtml(stripPreviewDirectiveLines(cell.source || ""));
  const withBreaks = escaped.replace(/\n/g, "<br />");
  return `<pre class="code-source">${withBreaks}</pre>`;
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

  // Replace $$...$$ first (display math, may span lines)
  let tokenized = source.replace(/\$\$([\s\S]+?)\$\$/g, (_match, math) => {
    const idx = displayMaths.length;
    displayMaths.push(math);
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
    const math = displayMaths[Number(idxStr)];
    if (math === undefined) { return _match; }
    try {
      // eslint-disable-next-line no-undef
      const rendered = katex.renderToString(math, { displayMode: true, throwOnError: false });
      return `<div class="katex-display-eq"><div class="katex-display-content">${rendered}</div><span class="eq-number"></span></div>`;
    } catch (e) {
      return `<div class="math-block-error">$$${escapeHtml(math)}$$</div>`;
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
 * Walk all display-math wrappers in DOM order and assign sequential equation numbers.
 * Called after any DOM update so numbers are always consistent across cells.
 */
function renumberEquations() {
  let n = 1;
  for (const el of document.querySelectorAll(".katex-display-eq .eq-number")) {
    el.textContent = `(${n++})`;
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
  let codeLines = [];

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

  const flushCodeFence = () => {
    if (!codeFence) {
      return;
    }

    blocks.push(`<pre class="markdown-code"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeFence = false;
    codeLines = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      flushParagraph();
      flushList();

      if (codeFence) {
        flushCodeFence();
      } else {
        codeFence = true;
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
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
      flushParagraph();
      flushList();
      blocks.push("<hr />");
      continue;
    }

    const blockquote = /^>\s?(.*)$/.exec(line);
    if (blockquote) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote><p>${renderInlineMarkdown(blockquote[1])}</p></blockquote>`);
      continue;
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      flushParagraph();
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
      if (listType && listType !== "ul") {
        flushList();
      }
      listType = "ul";
      listItems.push(unordered[1]);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  flushList();
  flushCodeFence();

  const rawHtml = blocks.join("");
  return `<div class="markdown-content">${restoreMathTokens(rawHtml, displayMaths, inlineMaths)}</div>`;
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+?)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+?)\*/g, "<em>$1</em>");
  html = html.replace(/\[([^\]]+?)\]\(([^)]+?)\)/g, (_match, label, target) => {
    const safeTarget = sanitizeHref(target);
    return `<a href="${safeTarget}" target="_blank" rel="noreferrer">${label}</a>`;
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

function renderOutputs(outputs) {
  if (!outputs || outputs.length === 0) {
    return "";
  }

  return outputs
    .map((output) => {
      if (output.dataUri) {
        return `<img class="cell-image" src="${output.dataUri}" alt="Notebook output" />`;
      }

      const safeText = escapeHtml(output.text || "");
      const label = output.mime || "text/plain";
      const className = output.mime === "application/vnd.code.notebook.stderr" || output.mime === "application/vnd.code.notebook.error"
        ? "output-block output-error"
        : "output-block";

      return `<div class="${className}"><div class="output-mime">${escapeHtml(label)}</div><pre>${safeText}</pre></div>`;
    })
    .join("");
}

function updateEmptyState() {
  const empty = state.cellOrder.length === 0;
  emptyState.style.display = empty ? "block" : "none";
  cellList.style.display = empty ? "none" : "grid";
}

function updateActiveVisual() {
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
