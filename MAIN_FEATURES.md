# VS Code Jupyter Notebook Preview - Main Features

## Product Goal
Build a VS Code extension that shows a live, scrollable notebook preview in a side editor tab while editing a `.ipynb` file.

## Primary User Scenarios
- Read notebook content and output without constantly switching tabs.
- Keep code editor and rendered notebook visible at the same time.
- Quickly navigate large notebooks from a structured outline.

## MVP Features

### 1. Side Editor Preview Panel
- Open a dedicated preview editor beside the notebook from command palette and notebook editor toolbar.
- Render notebook cells (markdown and code) in reading layout.
- Show cell outputs (text, images, tables, and basic HTML output where safe).
- Render inline and block LaTeX math using KaTeX for fast equation display.

### 2. Live Sync With Active Notebook
- Detect active notebook document and automatically bind preview to it.
- Update preview when cells are added, removed, reordered, or edited.
- Preserve scroll position when incremental updates occur.

### 3. Selection and Navigation Sync
- Click a preview cell to reveal/focus corresponding cell in notebook editor.
- Follow active notebook cell selection in preview (highlight state).
- Optional "auto-scroll to active cell" toggle.

### 4. Notebook Outline in Sidepane
- Display sections based on markdown headings.
- Support quick jump from outline item to target cell.
- Keep current section highlighted as user scrolls.

### 5. Performance and Stability Baseline
- Efficient rendering for medium/large notebooks (virtualized or incremental render).
- Debounced update pipeline to avoid re-render storms.
- Graceful handling for unsupported outputs (fallback message block).

## Security and Safety Requirements
- Sanitize rendered HTML outputs.
- Disallow arbitrary script execution in preview webview.
- Use VS Code webview CSP and nonce-based resource loading.
- Keep KaTeX trust mode disabled by default and validate user-defined macros.

## Accessibility Requirements
- Keyboard navigation for outline and preview cells.
- Screen-reader friendly labels for cell types and outputs.
- Respect VS Code theme variables and high-contrast mode.

## UX Details
- Commands:
  - `Notebook Preview: Open Preview Beside`
  - `Notebook Preview: Toggle Follow Active Cell`
  - `Notebook Preview: Refresh Preview`
- Status bar item showing preview connection state (Connected/No Active Notebook).
- Empty states:
  - No notebook open.
  - Notebook has no cells.
  - Output type unsupported.

## Nice-to-Have (Post-MVP)
- Diff mode between current and previous notebook state.
- Export preview as HTML/PDF.
- Search inside sidepane preview.
- Multi-notebook pinning (lock preview to a specific notebook).
- Cross-reference navigation (heading links, cell anchors, broken reference diagnostics).

## Non-Goals (Initial Version)
- Full notebook execution in preview pane.
- Interactive widget runtime parity with all Jupyter widget frameworks.
- Replacing the native VS Code notebook editor.

## Implementation Milestones
1. Scaffold extension + sidepane webview.
2. Render static notebook document in preview.
3. Add live update wiring from notebook events.
4. Implement bidirectional navigation sync.
5. Add outline, accessibility, and performance refinements.
6. Harden security model and finalize MVP.
7. Add cross-reference graph and in-preview reference navigation.

## Step-by-Step Implementation Plan

### Step 1 - Initialize Extension Workspace
- Create VS Code extension scaffold (TypeScript).
- Add build, watch, and package scripts.
- Configure strict TypeScript settings and lint/format setup.
- Done when extension runs in Extension Development Host with no build errors.

### Step 2 - Define Extension Surface
- Register commands for opening preview, refresh, and follow-active-cell toggle.
- Add notebook title contribution for opening the preview beside the active notebook.
- Add status bar item placeholder and activation events.
- Done when commands and side-editor preview appear in VS Code UI.

### Step 3 - Build Webview Shell
- Implement webview provider for editor-tab rendering.
- Add HTML template with CSP, nonce, and theme-aware CSS variables.
- Establish typed message channel between extension host and webview.
- Done when the preview tab loads a basic static page reliably beside the notebook.

## Progress Snapshot
- Implemented extension scaffold, build config, debug launch config, and command registration.
- Implemented preview webview editor tab that opens beside the active notebook.
- Implemented notebook snapshot/full-sync flow and basic incremental patch flow.
- Implemented active cell highlighting and click-to-focus navigation.
- Implemented rendering for code cells, basic outputs, and lightweight rich-text markdown formatting.
- Remaining major work: KaTeX, outline, cross-reference graph, debounced persistence, robust move diffing, and release hardening.

### Step 4 - Add Notebook Binding Layer
- Detect active notebook editor and subscribe to notebook lifecycle changes.
- Extract notebook model snapshot (cells, types, metadata, outputs).
- Send normalized snapshot payload to webview.
- Done when opening different notebooks updates the bound preview source.

### Step 5 - Implement Base Cell Rendering
- Render markdown and code cells in a readable, consistent layout.
- Support output primitives: plain text, images, tables, sanitized HTML.
- Add KaTeX rendering pipeline for inline/block math with graceful fallback on parse errors.
- Add graceful fallback blocks for unsupported MIME/output types.
- Done when most common notebook content is visible in preview.

### Step 6 - Introduce Incremental Live Updates
- Subscribe to notebook cell/document change events.
- Build debounced incremental update pipeline to patch only affected cells.
- Preserve preview scroll location during updates.
- Done when editing cells updates preview smoothly without full rerender.

### Step 7 - Add Navigation Sync (Preview -> Notebook)
- Make preview cells clickable and map clicks to notebook cell reveal/focus.
- Implement command bridge to reveal cell in active notebook editor.
- Add visual pressed/selected state feedback in preview.
- Done when clicking a preview cell consistently focuses the right notebook cell.

### Step 8 - Add Navigation Sync (Notebook -> Preview)
- Track active notebook cell selection changes.
- Highlight corresponding preview cell.
- Implement optional auto-scroll to active preview cell with user toggle.
- Done when selection changes in notebook are reflected in preview in near real time.

### Step 9 - Implement Sidepane Outline
- Parse markdown headings into a hierarchical section list.
- Render outline panel with keyboard navigation and jump-to-section behavior.
- Keep active section in sync with preview scroll position.
- Done when users can navigate long notebooks quickly via outline.

### Step 10 - Performance Hardening
- Add instrumentation timings for render and update pipeline.
- Introduce list virtualization/windowing for large notebooks.
- Optimize message payload size and avoid redundant DOM updates.
- Done when large notebooks remain responsive under normal editing patterns.

### Step 11 - Security and Accessibility Pass
- Enforce strict webview CSP and sanitize all rendered HTML outputs.
- Verify no script execution from notebook outputs.
- Add keyboard focus order, ARIA labels, and high-contrast checks.
- Done when security model is validated and accessibility baseline is met.

### Step 12 - Testing, Packaging, and Release
- Add unit tests for model normalization and outline parsing.
- Add integration tests for command wiring and sync behavior.
- Perform manual QA matrix: empty notebook, huge notebook, mixed output types.
- Package extension (`vsce package`) and document installation/usage.
- Done when release candidate passes tests and manual validation checklist.

### Step 13 - Cross-Reference and Research UX
- Implement reference graph and resolver for headings, equations, figures, and cell anchors.
- Add KaTeX-aware equation label/ref handling and broken reference diagnostics.
- Add references panel with inbound/outbound filters and history navigation.
- Done when cross-reference flows are stable and validated against research notebook scenarios.

## Suggested Delivery Rhythm
- Week 1: Steps 1-3 (foundation).
- Week 2: Steps 4-6 (core rendering + live sync).
- Week 3: Steps 7-9 (navigation + outline UX).
- Week 4: Steps 10-12 (hardening, testing, release baseline).
- Week 5: Step 13 (cross-reference and research-focused polish).

## Detailed Planning Documents
- Incremental preview updates and debounced saving: incremental_preview.md
- Cross-reference feature plan: crossref_feature_plan.md
