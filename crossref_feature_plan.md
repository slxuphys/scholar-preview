# Cross-Reference Feature Plan

## Goal
Add cross-reference support to the notebook preview editor tab so users can jump between related sections, cells, and citations without leaving the preview workflow.

## User Value
- Navigate large research notebooks faster.
- Follow references from one section to another with one click.
- Keep context with quick back/forward navigation in preview.

## Scope

### In Scope (Phase 1)
- Internal heading links from markdown content (for example: `#section-title`).
- Explicit cell anchors and deep links (for example: `#cell-42`).
- Equation labels and references (for example: `\\label{eq:loss}` with `\\ref{eq:loss}`).
- Figure labels and references (for example: `![caption](img.png){#fig:pipeline}` with `\\ref{fig:pipeline}`).
- Figures produced by Python code cell outputs (matplotlib, plotly static image, png/svg output bundles).
- KaTeX-based equation rendering for inline and block math in preview.
- Reference panel listing outbound links for the active section.
- Broken reference detection and non-blocking warnings.

### Out of Scope (Phase 1)
- External web crawling or link validation outside notebook content.
- Bibliography style formatting engines.
- Semantic citation extraction from PDFs.

## Cross-Reference Types
- `headingRef`: points to markdown heading slug.
- `cellRef`: points to stable cell key/anchor.
- `footnoteRef`: markdown footnote mapping (when available).
- `equationRef`: points to an equation label anchor.
- `figureRef`: points to a figure label anchor.
- `externalRef`: URL link rendered as external target.

## Functional Requirements

### 1. Reference Index Builder
- Parse notebook markdown cells into a reference graph.
- Build:
  - `anchorIndex`: anchor -> target cell key + offset
  - `outboundRefs`: cell key -> refs[]
  - `inboundRefs`: cell key -> refs[]
- Parse and index equation labels and figure labels as first-class anchors.
- Recompute incrementally when markdown cells change.

### 1.1 Equation and Figure Parsing Rules
- Equation anchors:
  - LaTeX block with label, example: `$$ ... \\label{eq:name} ... $$`
  - optional inline form when explicitly labeled, example: `$...$ \\label{eq:name}`
- Figure anchors:
  - markdown image with explicit id, example: `![caption](path){#fig:name}`
  - raw HTML figure id where allowed, example: `<figure id="fig:name">...`
  - code-output figure anchor from cell metadata or output metadata, example: `fig:name`
- Reference forms to resolve:
  - `\\ref{eq:name}`, `\\eqref{eq:name}`
  - `\\ref{fig:name}`
  - markdown links to anchors, example: `[see equation](#eq:name)`

### 1.2 KaTeX Rendering Pipeline
- Parse markdown into text + math token stream before render.
- Render inline math `$...$` and block math `$$...$$` via KaTeX.
- Preserve label tokens (`\\label{...}`) during parse for anchor indexing.
- Support `\\ref` and `\\eqref` text substitution after reference resolution.
- On KaTeX parse error, render non-blocking fallback with source preserved.

### 1.3 Python Output Figure Labeling
- Preferred labeling source: cell metadata field `crossref.figureLabel`.
- Optional output-level metadata fallback: `output.metadata.figureLabel`.
- Caption source priority:
  1. `crossref.figureCaption` in cell metadata
  2. `output.metadata.figureCaption`
  3. generated fallback (for example: "Figure from Cell 12")
- Supported output MIME anchors:
  - `image/png`
  - `image/jpeg`
  - `image/svg+xml`
  - `application/vnd.plotly.v1+json` (when rendered as a figure block)
- If multiple figure outputs exist in one cell, assign deterministic suffixes:
  - `fig:training-1`, `fig:training-2`, ...

### 2. Link Resolution
- Resolve references in priority order:
  1. exact cell anchor
  2. heading slug
  3. footnote id
  4. equation label
  5. figure label
- Mark unresolved references with warning style and tooltip reason.

### 3. Preview Interaction
- Clicking internal reference scrolls and highlights target cell.
- Maintain temporary pulse highlight on target for discoverability.
- Add preview history stack for back/forward navigation.

### 4. Reference Side Panel Block
- Show references for active cell/section:
  - outbound links
  - inbound links
- Provide filter chips: all, internal, equations, figures, footnotes, external.

### 5. Broken Reference UX
- Non-blocking warning icon near unresolved links.
- Hover text explains why resolution failed.
- Command: `Notebook Preview: Show Broken References`.

## Data Model

### Anchor Entry
- `anchorId`
- `cellKey`
- `cellIndex`
- `offset`
- `label`
- `kind` (`heading` | `cell` | `footnote` | `equation` | `figure`)
- `displayNumber` (optional, for Equation 1, Figure 2 style display)
- `caption` (optional, primarily for figures)

### Reference Entry
- `refId`
- `sourceCellKey`
- `rawTarget`
- `resolvedTargetAnchorId` (optional)
- `kind`
- `isResolved`
- `displayText` (optional, rendered as Eq. N or Fig. N)

## Incremental Update Strategy
- Re-parse only changed markdown cells.
- Update graph entries for affected cells.
- Recompute inbound edges only for impacted targets.
- Emit minimal updates to webview reference panel.
- Re-index figure anchors when output bundles or relevant metadata change.

## Performance Targets
- Index build on open (500 cells): under 200 ms.
- Incremental update for single-cell edit: under 30 ms.
- Navigation response after click: under 100 ms.
- Re-index of one changed output cell: under 20 ms.
- KaTeX render for one edited math cell: under 25 ms on typical notebook hardware.

## Accessibility
- All reference links keyboard reachable.
- Announce unresolved reference state to screen readers.
- Back/forward history actions have accessible labels.
- Expose equation/figure numbers in accessible link labels.

## Security
- Sanitize rendered markdown link labels.
- Open external links only through VS Code trusted URI flow.
- Block javascript pseudo-links.
- Restrict KaTeX trust mode (disabled by default) and disallow unsafe HTML-like commands.
- Validate/limit custom macros from settings before applying them.

## Commands and Settings

### Commands
- `Notebook Preview: Toggle References Panel`
- `Notebook Preview: Show Broken References`
- `Notebook Preview: Navigate Back in Preview`
- `Notebook Preview: Navigate Forward in Preview`

### Settings
- `notebookPreview.crossRef.enabled` (boolean, default: true)
- `notebookPreview.crossRef.showInbound` (boolean, default: true)
- `notebookPreview.crossRef.highlightDurationMs` (number, default: 1200)
- `notebookPreview.crossRef.equationPrefix` (string, default: "Eq.")
- `notebookPreview.crossRef.figurePrefix` (string, default: "Fig.")
- `notebookPreview.crossRef.figureLabelSource` (string enum: `cellMetadata|outputMetadata|auto`, default: `cellMetadata`)
- `notebookPreview.math.renderer` (string enum: `katex|none`, default: `katex`)
- `notebookPreview.math.katexTrust` (boolean, default: false)
- `notebookPreview.math.katexMacros` (object, default: `{}`)

## Implementation Sequence
1. Define anchor/reference types and graph store.
2. Build markdown parser pipeline for anchors and links.
3. Add KaTeX math rendering stage with equation label preservation.
4. Add equation/figure parser and numbering strategy.
5. Add output-figure extractor from code cell outputs and metadata.
6. Implement resolver and unresolved diagnostics.
7. Add preview click navigation + target highlighting.
8. Add history stack (back/forward).
9. Add references panel UI and filters.
10. Wire incremental graph updates from notebook change events.
11. Add settings and commands.
12. Add tests and performance instrumentation.

## Testing Checklist
- heading links resolve after heading rename.
- cell anchor links resolve after cell reorder.
- equation refs resolve after equation label edits and cell moves.
- figure refs resolve after caption/image block moves.
- equation and figure numbering updates correctly after inserts/deletes.
- figure refs resolve for Python-generated outputs after re-execution.
- label collisions between markdown figure and output figure are detected and surfaced.
- output figure with no metadata label is auto-labeled predictably when enabled.
- KaTeX inline and block math render correctly across markdown edits.
- KaTeX parse errors show safe fallback without breaking reference indexing.
- unresolved refs are surfaced but do not break rendering.
- back/forward history remains correct after notebook edits.
- external links use safe open behavior only.

## Done Criteria
- Internal references navigate reliably in common research notebook patterns.
- Equation and figure references resolve and display consistent numbering.
- Broken links are visible and actionable.
- Cross-reference index updates incrementally without full rebuild in most edits.
- No measurable regressions to base preview responsiveness.
