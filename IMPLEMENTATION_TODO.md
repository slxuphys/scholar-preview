# Implementation To-Do

## Foundation
- [x] Scaffold VS Code extension (TypeScript) and verify Extension Development Host launch.
- [x] Add build/watch/package scripts and strict TypeScript config.
- [ ] Register commands:
  - [x] Notebook Preview: Open Preview Beside
  - [x] Notebook Preview: Toggle Follow Active Cell
  - [x] Notebook Preview: Refresh Preview
- [x] Replace sidepane approach with side-editor webview open flow.
- [x] Add notebook title-bar entry point and debug launch configuration.
- [x] Add status bar connection state indicator.

## Webview and Rendering Core
- [x] Implement webview provider with CSP and nonce.
- [x] Create typed extension-host <-> webview message protocol.
- [x] Render markdown and code cells in side-editor layout.
- [ ] Render output primitives:
  - [x] plain text
  - [x] images
  - [ ] tables
  - [ ] sanitized HTML
- [x] Add graceful fallback blocks for unsupported outputs.

## Current Progress Notes
- [x] Added rich-text markdown formatting for headings, paragraphs, lists, blockquotes, links, inline code, and fenced code blocks.
- [x] Added JSON, stdout/stderr, and notebook error rendering in code cell outputs.
- [ ] Replace handwritten markdown formatting with a full markdown + KaTeX pipeline.

## Math Rendering (KaTeX)
- [ ] Add KaTeX pipeline for inline (`$...$`) and block (`$$...$$`) math.
- [ ] Preserve equation labels during parse for reference indexing.
- [ ] Add safe fallback display on KaTeX parse errors.
- [ ] Add settings:
  - [ ] `notebookPreview.math.renderer`
  - [ ] `notebookPreview.math.katexTrust` (default false)
  - [ ] `notebookPreview.math.katexMacros`
- [ ] Validate macro input and keep trust mode disabled by default.

## Incremental Preview Updates
- [x] Build notebook event normalizer for insert/delete/move/update ops.
- [x] Implement patch protocol with `baseVersion` and `docVersion`.
- [ ] Add debounce/coalescing queue for patch batches.
- [x] Implement full-sync fallback on version mismatch/failure.
- [ ] Preserve scroll anchor across patch apply.

## React State Isolation (Per Cell)
- [x] Implement store shape:
  - [x] `cellOrder`
  - [x] `cellStateById`
  - [x] `activeCellId`
  - [x] `docVersion`
- [x] Render ordered DOM from `cellOrder` only.
- [ ] Implement reducer ops:
  - [x] `recordCellSnapshot`
  - [ ] `copyCell`
  - [x] `deleteCells`
  - [ ] `moveCells`
- [ ] Enforce single-cell edit isolation:
  - [x] only target cell state changes on edit
  - [x] untouched cell DOM nodes are preserved in the current webview renderer
  - [ ] `React.memo` for cell component
  - [x] stable `key` by cell id (never index)

## Debounced Saving
- [ ] Add in-memory checkpoint debounce (300-500 ms).
- [ ] Add persisted state debounce (1000-2000 ms).
- [ ] Flush immediately on:
  - [ ] notebook switch
  - [ ] preview disposal
  - [ ] extension deactivation
- [ ] Prevent concurrent save races with versioned save guard.

## Navigation and Outline
- [x] Implement preview -> notebook focus sync.
- [x] Implement notebook -> preview active highlight sync.
- [x] Add optional auto-scroll to active cell toggle.
- [ ] Build markdown heading outline with jump navigation.
- [ ] Keep outline active section synced with preview scroll.

## Cross-Reference System
- [ ] Build reference graph (`anchorIndex`, `outboundRefs`, `inboundRefs`).
- [ ] Support reference types:
  - [ ] headings
  - [ ] cell anchors
  - [ ] footnotes
  - [ ] equations
  - [ ] figures
  - [ ] external links
- [ ] Implement resolution priority and unresolved diagnostics.
- [ ] Add references panel with filters (all/internal/equations/figures/footnotes/external).
- [ ] Add click navigation + target highlight pulse.
- [ ] Add preview history stack (back/forward).

## Equation and Figure References
- [ ] Parse equation labels (`\\label{eq:...}`) and refs (`\\ref`, `\\eqref`).
- [ ] Parse markdown figure ids and HTML figure anchors.
- [ ] Index Python-output figures from metadata and MIME bundles.
- [ ] Add deterministic suffixing for multiple output figures in one cell.
- [ ] Add collision detection for duplicate figure labels.
- [ ] Add numbering display for equation/figure references.

## Security and Accessibility
- [ ] Sanitize all rendered HTML content.
- [ ] Block script execution and unsafe URI schemes.
- [ ] Ensure external links use VS Code trusted open flow.
- [ ] Add keyboard navigation for preview and references panel.
- [ ] Add ARIA labels, including equation/figure numbering labels.
- [ ] Validate high-contrast and theme variable compatibility.

## Performance and Observability
- [ ] Add timing metrics:
  - [ ] event-to-patch latency
  - [ ] patch apply duration
  - [ ] payload size
  - [ ] full-sync fallback count
  - [ ] save delay/flush latency
- [ ] Add virtualization/windowing for large notebooks.
- [ ] Batch reducer dispatches and schedule DOM writes in `requestAnimationFrame`.
- [ ] Add payload budgeting for large outputs.

## Testing and Release
- [ ] Unit tests:
  - [ ] model normalization
  - [ ] outline parsing
  - [ ] reference resolver
- [ ] Integration tests:
  - [ ] command wiring
  - [ ] bidirectional sync
  - [ ] incremental patch application
- [ ] Scenario tests:
  - [ ] one-cell edit does not rerender neighbors
  - [ ] reorder/copy/delete preserves JSX order
  - [ ] KaTeX render/fallback behavior
  - [ ] equation/figure refs stay correct after edits/re-execution
- [ ] Manual QA matrix (empty/large/mixed-output notebooks).
- [x] Document local build/run usage.
- [ ] Package extension.
