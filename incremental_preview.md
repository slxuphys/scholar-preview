# Incremental Preview Update Plan

## Goal
Implement a low-latency incremental update pipeline for the preview editor tab so notebook edits are reflected without full rerender.

## Design Principles
- Prefer patch-based updates over full document refresh.
- Keep extension host and webview in versioned sync.
- Preserve scroll/reading context during updates.
- Provide safe fallback to full sync on mismatch or failure.

## 1. Data Model and Identity

### 1.1 Cell Identity
- Assign each preview cell a stable `cellKey`.
- Derive `cellKey` from notebook cell URI when available.
- Never rely on array index as identity.

### 1.2 Cell Snapshot Shape
Store normalized state per cell:
- `cellKey`
- `kind` (markdown/code)
- `source`
- `outputs`
- `metadata`
- `sourceHash`
- `outputHash`
- `metadataHash`

### 1.3 Document State
Track:
- `docVersion` (monotonic integer)
- `cells` (ordered array of `cellKey`)
- `cellMap` (`cellKey -> snapshot`)
- `activeCellKey`

### 1.4 React Cell State Store
Keep UI state per cell in React so JSX order and cell rendering are deterministic.

Recommended shape:
- `cellOrder: string[]` (source of truth for render order)
- `cellStateById: Record<string, CellViewState>`
- `activeCellId?: string`
- `docVersion: number`

Suggested `CellViewState` fields:
- `id`
- `kind`
- `source`
- `renderedHtml` (sanitized)
- `outputs`
- `outputHtml` (sanitized)
- `isCollapsed`
- `isSelected`
- `lastUpdatedVersion`

Render rule in React:
- JSX list must be rendered from `cellOrder.map(id => <Cell key={id} ... />)`.
- Never render from `Object.keys(cellStateById)` because object key order is not the intended notebook order.

## 2. Event Ingestion (Extension Host)

### 2.1 Sources
- Notebook document change events.
- Notebook output change events.
- Active cell/selection change events.
- Notebook switch (active editor changed).

### 2.2 Normalize Event Types
Convert raw VS Code events into operations:
- `insertCells`
- `deleteCells`
- `moveCells`
- `copyCell`
- `recordCellSnapshot`
- `updateCellSource`
- `updateCellOutputs`
- `updateCellMetadata`
- `setActiveCell`

### 2.3 Operation Semantics for React/JSX
- `recordCellSnapshot`
	- Update existing `cellStateById[id]` content fields.
	- Keep `cellOrder` unchanged.
	- For normal edits, update only the currently edited cell id.
- `copyCell`
	- Clone source cell state with a new stable id.
	- Insert new id into `cellOrder` at target index.
- `deleteCells`
	- Remove ids from both `cellOrder` and `cellStateById`.
- `moveCells`
	- Reorder ids in `cellOrder` only.
	- Do not recreate cell state objects unless required.

## 3. Coalescing and Debounce

### 3.1 Batch Window
- Use a short debounce window (40-100 ms).
- Collect all operations in this window into one patch batch.

### 3.2 Merge Rules
- Remove superseded operations in the same window.
- Example: update then delete same cell -> keep only delete.
- Merge adjacent inserts/deletes when possible.

### 3.3 Debounced Saving
- Use a separate save debounce from render debounce.
- Suggested delays:
	- in-memory preview state checkpoint: 300-500 ms after last change
	- persisted extension state save: 1000-2000 ms after last change
- Save triggers:
	- notebook content/structure changes
	- follow-active-cell setting changes
	- sidepane outline expand/collapse state changes (if persisted)
- Immediate flush triggers (skip debounce):
	- active notebook switch
	- preview disposal/webview close
	- extension deactivation
- Reliability rules:
	- never run concurrent saves for the same notebook key
	- if save is in progress, queue one trailing save with latest state
	- include `savedVersion` so stale save completions are ignored

## 4. Patch Protocol

### 4.1 Message Envelope
Each patch message should include:
- `type: "patch"`
- `baseVersion`
- `docVersion`
- `ops: PatchOp[]`

### 4.2 Full Snapshot Message
Recovery message should include:
- `type: "fullSync"`
- `docVersion`
- full normalized notebook payload

### 4.3 Acknowledgement (Optional)
- Webview may send `ack` with applied version for observability.

## 5. Webview Patch Application

### 5.1 Local Mirror
Maintain a mirror:
- `docVersion`
- `cells` order list
- `cellMap`
- DOM node index (`cellKey -> element`)

### 5.2 Version Gate
- Accept patch only when `baseVersion === localDocVersion`.
- If mismatch, request `fullSync`.

### 5.3 Targeted DOM Updates
- Insert/delete/move only affected nodes.
- Source/output updates patch only changed cell subtree.
- Avoid rerendering the full list container.

### 5.4 React Reducer Pattern
- Apply every patch op through a single reducer (or Zustand/Redux equivalent).
- Keep updates immutable so React can diff efficiently.
- For reorder operations, update only `cellOrder` and preserve cell component keys.
- For copy operations, create a new id before state insertion to avoid key collisions.
- For delete operations, remove from map first, then compact `cellOrder`.

### 5.5 Single-Cell Edit Isolation (No Full DOM Refresh)
- For `updateCellSource`, `updateCellOutputs`, and `recordCellSnapshot`, mutate state for one target cell id only.
- Reuse object references for all untouched cells so React skip-renders non-target cells.
- Render cell component as memoized (`React.memo`) with stable props and custom equality check if needed.
- Keep list parent free of derived props that change on every keystroke (for example, avoid recreating callbacks for all cells).
- Ensure `key` is stable cell id, never list index.
- Do not rebuild `cellOrder` for single-cell edits.
- Avoid "map-to-new-object" across all cells during one-cell edits.

## 6. Scroll Preservation

### 6.1 Anchor Capture
Before applying patch:
- Identify top visible cell key as anchor.
- Capture relative pixel offset from viewport top.

### 6.2 Restore
After patch apply:
- Scroll anchor back to prior offset.
- If anchor deleted, use nearest surviving neighbor.

## 7. Fallback and Recovery

### 7.1 Full Resync Conditions
Trigger full sync when:
- version mismatch
- patch application exception
- patch touches very large fraction of cells
- notebook binding changed

### 7.2 Safety Rule
- Full sync is recovery path, not normal path.

## 8. Performance Strategy

### 8.1 Rendering
- Render incrementally.
- Use virtualization/windowing for large notebooks.
- Lazy render heavy outputs (large HTML/tables/images) offscreen.

### 8.2 Scheduling
- Group DOM writes in `requestAnimationFrame`.
- Avoid read/write interleaving that causes layout thrash.
- Batch reducer dispatches to avoid one render per operation.
- For rapid typing, coalesce repeated edits to the same cell id before dispatch.

### 8.3 Payload Budgeting
- Send only changed fields in update ops.
- Cap oversized output payloads and request lazy fetch if needed.

## 9. Security Constraints
- Sanitize HTML outputs before rendering in webview.
- Enforce strict CSP and nonce usage.
- Do not execute arbitrary output scripts.

## 10. Observability
Track metrics:
- event-to-patch latency
- patch apply duration
- payload size per patch
- full-sync fallback count
- failed patch count
- debounced save delay vs actual flush time
- save failure count and retry count

## 11. Testing Checklist

### 11.1 Functional
- rapid typing in one cell
- add/remove/reorder cells
- copy cell then edit copied cell independently
- delete selected cell and verify next selection behavior
- output changes from execution
- switch active notebook during edits
- edit one cell and verify neighboring cells do not rerender

### 11.2 Resilience
- intentionally drop one patch to validate full-sync recovery
- simulate version mismatch

### 11.3 UX
- scroll position remains stable during updates
- active-cell highlight remains correct
- JSX order always matches notebook order after move/copy/delete sequences
- no visible flicker in untouched cells during one-cell edits

## 12. Implementation Sequence
1. Define normalized model and patch types.
2. Define React cell store (`cellOrder` + `cellStateById`).
3. Build host event normalizer.
4. Implement debounce/coalesce queue.
5. Implement debounced saving with flush-on-dispose/switch.
6. Send patch envelope to webview.
7. Build webview mirror + patch reducer.
8. Implement copy/delete/move/record reducer operations.
9. Add version gate and full-sync recovery.
10. Add scroll anchor preservation.
11. Add performance optimizations and metrics.
12. Validate using test checklist.

## Done Criteria
- Typical cell edits update preview in under 120 ms on medium notebooks.
- Full rerender is rare and only used as fallback.
- Editing one cell does not trigger DOM refresh for unaffected cells.
- No visible scroll jump in common edit flows.
- Patch failures recover automatically without user action.
