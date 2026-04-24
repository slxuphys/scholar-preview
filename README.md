# Notebook Preview

A VS Code extension scaffold for a live Jupyter notebook preview that opens in a side editor tab beside the active notebook.

## Current Capabilities
- Webview editor tab opens beside the active notebook.
- Commands for open preview beside, refresh, and follow-active-cell toggle.
- Notebook title-bar entry point for opening the preview.
- Snapshot + patch protocol foundation for incremental updates.
- Per-cell state store in webview with targeted single-cell updates.
- Active-cell sync between notebook selection and preview highlight.
- Preview-to-notebook click navigation.
- Text, JSON, error, stdout/stderr, and image output rendering.
- Lightweight rich-text markdown rendering for headings, lists, blockquotes, links, and code fences.

## Run Locally
1. Install dependencies:
   - `npm install`
2. Compile:
   - `npm run compile`
3. Start Extension Development Host:
   - press `F5` in VS Code

## Notes
- KaTeX integration is still a placeholder in `media/main.js`; math is only visually marked today.
- Complex reorder detection still falls back to full sync rather than emitting move patches.
- The renderer is currently handwritten markdown formatting, not a full markdown parser.
