# Notebook Preview — Known Gaps & TODOs

Last updated: 2026-04-26

## Markdown Renderer

- [x] **GFM pipe tables** — `| col | col |` syntax, with alignment (`:---`, `---:`, `:---:`)
- [x] **Strikethrough** — `~~text~~` renders as `<del>`
- [x] **Task list items** — `- [ ]` / `- [x]` render with disabled checkboxes (`.task-item`)
- [x] **Nested/indented lists** — recursive renderer using indent level; mixed ol/ul at different depths works
- [x] **Underscore bold/italic** — `__bold__` / `_italic_` supported (word-boundary–aware regex)
- [x] **Hard line breaks** — trailing two spaces + newline produces `<br />`

## Output Rendering

- [x] **`text/markdown` outputs** — rendered via `renderMarkdownCell` (full markdown pipeline incl. math, tables, lists)
- [x] **`text/latex` outputs** — now captured in provider; rendered as KaTeX display block (strips surrounding `$`/`$$` if present)

## UX / Polish

- [ ] **Dark mode CSS** — some rules are hardcoded light:
  - `th` background `#f5f6f7`
  - toolbar `rgba(255,255,255,0.96)`
  - empty-state `#fafbfc`
- [ ] **Scroll position** — jumps to top on every full sync; should preserve on incremental patches
- [ ] **`bibCache` persistence** — cleared on extension reload; no persistence between sessions

## Cross-Reference / Citation

- [ ] **Undefined label warning** — `@ref` with no matching label silently shows "??"; should highlight in red or show a tooltip
- [x] **Multi-level section numbering in refs** — `renumberCrossRefs` builds dotted strings (e.g. "2.3") and updates all `.sec-ref` links correctly.

## Security Note

- [ ] **Unsanitized `text/html` outputs** — injected directly as `innerHTML`; scripts in output HTML execute in the webview. Low risk for own notebooks, but consider a sandbox attribute on the webview frame or DOMPurify for untrusted notebooks.

## Known Minor Bugs

- [ ] **B1** — `open()` calls `refresh()` before webview is loaded (minor race, self-heals on next event)
- [ ] **B4** — `moveCells` anchor calculation is incorrect for non-trivial multi-cell moves
- [ ] **B5** — `pushMarkdownUpdate` version counter stalls when content is unchanged
