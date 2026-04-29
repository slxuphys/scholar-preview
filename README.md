# Notebook Preview

A VS Code extension that opens a live, typeset preview of a Jupyter notebook (or standalone Markdown file) in a side panel.  Two preview modes are available:

- **HTML preview** — fast incremental preview with KaTeX math, syntax highlighting, and cross-references, rendered directly in the webview.
- **Typst paged preview** — high-fidelity paged preview (A4) driven by [Typst](https://typst.app/), with numbered equations, figure captions, cross-references, and PDF export.

## Features

### HTML Live Preview
- Opens beside the active `.ipynb` or `.md` file via the notebook/editor title-bar button.
- Incremental patch protocol — only changed cells are re-rendered.
- Active-cell highlight syncs with notebook selection; click any cell in the preview to navigate back.
- Preview is preserved when switching to unrelated editors.

### Typst Paged Preview
- Opens as a separate side panel via **"Notebook Preview: Open Typst Paged Preview"** in the Command Palette or the notebook title-bar button.
- Continuous live updates via `typst watch` — pages update automatically as you edit, with no blink (images swapped in-place).
- **Export to PDF** button — runs `typst compile` and opens the PDF.
- **Download `.typ` source** button — saves the generated Typst file for further editing.

### Markdown Rendering
- Headings, lists, blockquotes, bold/italic, inline code, fenced code blocks, links, images, horizontal rules.
- YAML front matter rendered as a centred title block (title, author, affiliation, date).
- Quarto `#|` cell directives parsed: `echo`, `fig-cap`, `label`, `fig-label`.

### Math
- Inline math: `$...$`
- Display math: `$$...$$` (multi-line supported)
- Numbered equations with `@label` cross-references.
- Rendered via **KaTeX** (HTML preview) or **mitex** (Typst preview).

### Cross-References (Typst preview)
| Syntax | Renders as |
|---|---|
| `@eq-label` | Eq. (N) with hyperlink |
| `@fig-label` | Fig. N with hyperlink |
| `@any-label` | Default Typst reference |

### Quarto Directives (`#|`)
| Directive | Effect |
|---|---|
| `#\| echo: false` / `off` | Hides source code block |
| `#\| fig-cap: "..."` | Figure caption in `#figure(...)` |
| `#\| label: "fig-..."` | Figure label for cross-references |
| `#\| fig-label: "..."` | Alternative label key |

### YAML Front Matter
Add a metadata block to the first Markdown cell:
```yaml
---
title: Non-Equilibrium Statistical Mechanics
author: John Smith
affiliation: Department of Physics, University of XYZ
date: 2024-06-01
---
```
Renders as a centred title block. The raw `---` block is stripped from the preview.

### HTML Preview — Additional Features
- Syntax highlighting via **highlight.js**.
- Serif body text via **Crimson Text** (Google Fonts).
- `@doi:10.xxxx/yyyy` / `@arxiv:NNNN.NNNNN` inline citations with bibliography fetch.
- Section and figure auto-numbering with `{#sec-}` / `{#fig-}` anchors.
- Export to browser for printing (fully self-contained HTML).

## Toolbar Buttons

### HTML Preview
| Icon | Action |
|---|---|
| ↻ Refresh | Force full re-sync |
| 👁 Follow | Toggle auto-scroll to active cell |
| 📖 Fetch bib | Fetch bibliography metadata |
| ↗ Open | Export to browser for printing |

### Typst Preview
| Icon | Action |
|---|---|
| ↻ Recompile | Force recompile |
| ↓ Export PDF | Run `typst compile` and open PDF |
| ☁ Download `.typ` | Save generated Typst source |

## Quick Reference

```markdown
---
title: My Paper
author: Jane Smith
affiliation: MIT
date: 2026
---

# Introduction

Display math with label:

$$
E = mc^2
$$ {#eq-energy}

Cross-reference: see @eq-energy.
```

```python
#| echo: false
#| fig-cap: "Normal distribution PDF"
#| label: "fig-normal"

import matplotlib.pyplot as plt
# ... plot code ...
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
- [Typst](https://typst.app/) on your `PATH` (for Typst paged preview and PDF export)
- Internet access for bibliography fetching (HTML preview, CrossRef / arXiv APIs)

## Comparison with Quarto

| Aspect | This extension | Quarto |
|---|---|---|
| **Trigger** | Live — re-renders on every keystroke/cell save | `quarto preview` polls file changes |
| **Code execution** | None — reads already-executed outputs from `.ipynb` | Executes code cells via Jupyter / Knitr |
| **Math** | KaTeX (HTML) / mitex (Typst) | KaTeX or MathJax |
| **Cross-refs** | `@label` resolved in Typst preview | Full Pandoc filter across files |
| **Output formats** | Live HTML webview + Typst PDF | HTML, PDF (LaTeX/Typst), Word, RevealJS, … |
| **Latency** | ~ms incremental | Seconds — full Pandoc + Jupyter re-run |
| **Multi-file** | Single notebook | Projects, books, websites |

The extension is optimised for **speed** — you see changes as you type with no re-execution cost. Quarto is optimised for **fidelity** — publication-quality output across many formats. They complement each other: iterate here, render final output with Quarto.

