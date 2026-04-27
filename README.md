# Notebook Preview

A VS Code extension that opens a live, typeset preview of a Jupyter notebook (or standalone Markdown file) in a side panel. The preview updates incrementally as you edit, renders math, code, figures, and cross-references, and can export a self-contained HTML page for printing.

## Features

### Live Preview
- Opens beside the active `.ipynb` or `.md` file via the notebook/editor title-bar button.
- Incremental patch protocol — only changed cells are re-rendered (O(changed cells)).
- Active-cell highlight syncs with notebook selection; click any cell in the preview to navigate back.
- Preview is preserved when switching to unrelated editors (Python, JSON, etc.).

### Markdown Rendering
- Full-featured handwritten Markdown renderer: headings, lists, blockquotes, bold/italic, inline code, fenced code blocks, links, images, and horizontal rules.
- Syntax highlighting for code cells via **highlight.js**.
- Serif body text via **Crimson Text** (Google Fonts).

### Math (KaTeX)
- Inline math: `$...$`
- Display math: `$$...$$`
- Numbered equations with `@eq-label` cross-references resolved across all cells.

### Cross-References
| Syntax | Resolves to |
|---|---|
| `@eq-label` | Eq. (N) |
| `@fig-label` | Fig. N |
| `@sec-label` | Section N / N.M |

### Section & Figure Numbering
- Headings (`#`, `##`, `###`) are auto-numbered (e.g. 1, 1.2, 1.2.3) with muted prefix.
- Figures declared with `<!-- fig: label "Caption" -->` are numbered sequentially.

### Citations
- `@doi:10.xxxx/yyyy` — DOI citation, linked to `doi.org`.
- `@arxiv:NNNN.NNNNN` — arXiv citation, linked to `arxiv.org`.
- Inline markers rendered as superscript `[N]` with deduplication.
- Auto-generated **References** section at the bottom.

### Bibliography Fetch (book icon)
Click the book icon in the toolbar to fetch full metadata for all cited works:
- CrossRef API for DOI citations → formats as *Authors. "Title." Journal Vol, Pages (Year).*
- arXiv API for arXiv citations → formats as *Authors. "Title." arXiv:NNNN.NNNNN (Year).*
- Fetching runs in the extension host (no CORS issues).
- Results are cached for the session; hover any `[N]` inline citation to see the full entry.

### YAML Front Matter
Add a metadata block to the first Markdown cell:
```yaml
---
title: "My Research Paper"
author: "Jane Smith"
date: "April 2026"
---
```
Renders as a centred title block above all cells. The raw YAML cell is hidden from the preview.

### Open in Browser
Export a fully self-contained HTML page (styles + rendered content) for printing or sharing. The exported page includes the doc header, all visible cells, and the reference list.

## Toolbar Buttons

| Icon | Action |
|---|---|
| ↻ Refresh | Force full re-sync |
| 👁 Follow | Toggle auto-scroll to active cell |
| 📖 Fetch bib | Fetch bibliography metadata |
| ↗ Open | Export to browser for printing |

## Syntax Quick Reference

```markdown
---
title: My Paper
author: Jane Smith
date: 2026
---

# Introduction {#sec-intro}

See @sec-intro or @eq-energy or @fig-results.

$$E = mc^2 \tag{eq-energy}$$

<!-- fig: results "Figure 1 caption" -->
![](path/to/image.png)

Cite a DOI @doi:10.1103/PhysRevX.8.021013 or arXiv paper @arxiv:2101.00004.
```

## Run Locally

```bash
npm install
npm run compile
# Press F5 in VS Code to launch Extension Development Host
```

## Requirements

- VS Code 1.90+
- Node.js (for compilation)
- Internet access for bibliography fetching (CrossRef / arXiv APIs)
