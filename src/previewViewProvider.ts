import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import {
  CellSnapshot,
  HostToWebviewMessage,
  NotebookSnapshot,
  OutputSnapshot,
  PatchOp,
  WebviewToHostMessage
} from "./protocol";

export class NotebookPreviewViewProvider {
  private panel?: vscode.WebviewPanel;
  private snapshot?: NotebookSnapshot;
  private followActiveCell = vscode.workspace.getConfiguration().get<boolean>("notebookPreview.followActiveCell", true);
  private statusBar: vscode.StatusBarItem;

  constructor(private readonly extensionUri: vscode.Uri) {
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.statusBar.command = "notebookPreview.openSidepanePreview";
    this.statusBar.text = "Notebook Preview: Open Preview Beside";
    this.statusBar.show();

    vscode.window.onDidChangeActiveNotebookEditor(() => {
      this.refresh();
    });

    vscode.window.onDidChangeActiveTextEditor(() => {
      this.refresh();
    });

    vscode.workspace.onDidChangeTextDocument((event) => {
      // Notebook cell documents also have languageId "markdown" — skip them.
      if (event.document.uri.scheme === "vscode-notebook-cell") {
        return;
      }
      if (event.document.languageId !== "markdown") {
        return;
      }
      const activeTextEditor = vscode.window.activeTextEditor;
      if (!activeTextEditor || activeTextEditor.document.uri.toString() !== event.document.uri.toString()) {
        return;
      }
      this.pushMarkdownUpdate(event.document);
    });

    vscode.window.onDidChangeNotebookEditorSelection((event) => {
      const active = event.selections[0];
      if (!active || !this.snapshot) {
        return;
      }

      const activeCellId = this.snapshot.cellOrder[active.start];
      if (!activeCellId) {
        return;
      }

      this.postMessage({
        type: "patch",
        baseVersion: this.snapshot.docVersion,
        docVersion: this.snapshot.docVersion + 1,
        ops: [{ type: "setActiveCell", id: activeCellId }]
      });

      this.snapshot.docVersion += 1;
      this.snapshot.activeCellId = activeCellId;
    });

    vscode.workspace.onDidChangeNotebookDocument((event) => {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor || editor.notebook.uri.toString() !== event.notebook.uri.toString()) {
        return;
      }

      this.pushIncrementalUpdate(event);
    });
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "notebookPreview.editor",
      this.getPanelTitle(),
      {
        viewColumn: vscode.ViewColumn.Beside,
        preserveFocus: true
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          ...(vscode.workspace.workspaceFolders?.map((f) => f.uri) ?? [])
        ]
      }
    );

    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, "media", "preview.svg");
    this.panel.onDidDispose(() => {
      this.panel = undefined;
    });

    this.panel.webview.html = this.getHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((message: WebviewToHostMessage) => {
      this.handleWebviewMessage(message);
    });

    this.refresh();
  }

  refresh(): void {
    // Markdown text editor takes priority — but not notebook cell editors (same languageId, different scheme).
    const textEditor = vscode.window.activeTextEditor;
    if (
      textEditor?.document.languageId === "markdown" &&
      textEditor.document.uri.scheme !== "vscode-notebook-cell"
    ) {
      this.refreshMarkdown(textEditor.document);
      return;
    }

    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
      this.snapshot = undefined;
      this.statusBar.text = "Notebook Preview: No Active File";
      if (this.panel) {
        this.panel.title = this.getPanelTitle();
      }
      this.postMessage({ type: "status", text: "No active notebook or markdown editor." });
      return;
    }

    this.snapshot = buildSnapshot(editor.notebook, this.snapshot?.docVersion ?? 0);
    this.statusBar.text = "Notebook Preview: Connected";
    if (this.panel) {
      this.panel.title = this.getPanelTitle(editor.notebook.uri);
    }
    const notebookDir = this.panel
      ? this.panel.webview.asWebviewUri(
          vscode.Uri.joinPath(editor.notebook.uri, "..")
        ).toString()
      : "";
    this.postMessage({ type: "fullSync", snapshot: this.snapshot, notebookDir });
  }

  private refreshMarkdown(document: vscode.TextDocument): void {
    this.snapshot = buildMarkdownSnapshot(document, this.snapshot?.docVersion ?? 0);
    this.statusBar.text = "Notebook Preview: Connected";
    if (this.panel) {
      this.panel.title = this.getPanelTitle(document.uri);
    }
    const docDir = this.panel
      ? this.panel.webview.asWebviewUri(vscode.Uri.joinPath(document.uri, "..")).toString()
      : "";
    this.postMessage({ type: "fullSync", snapshot: this.snapshot, notebookDir: docDir });
  }

  private pushMarkdownUpdate(document: vscode.TextDocument): void {
    const nextSnapshot = buildMarkdownSnapshot(document, this.snapshot?.docVersion ?? 0);
    const docDir = this.panel
      ? this.panel.webview.asWebviewUri(vscode.Uri.joinPath(document.uri, "..")).toString()
      : "";

    if (!this.snapshot) {
      this.snapshot = nextSnapshot;
      this.postMessage({ type: "fullSync", snapshot: nextSnapshot, notebookDir: docDir });
      return;
    }

    const id = document.uri.toString();
    const prevCell = this.snapshot.cells[id];
    const nextCell = nextSnapshot.cells[id];

    if (prevCell && nextCell && hasCellChanged(prevCell, nextCell)) {
      this.snapshot = nextSnapshot;
      this.postMessage({
        type: "patch",
        baseVersion: nextSnapshot.docVersion - 1,
        docVersion: nextSnapshot.docVersion,
        ops: [{ type: "recordCellSnapshot", id, cell: nextCell }]
      });
    } else if (!prevCell) {
      // Different markdown file opened — full sync
      this.snapshot = nextSnapshot;
      this.postMessage({ type: "fullSync", snapshot: nextSnapshot, notebookDir: docDir });
    }
  }

  toggleFollowActiveCell(): void {
    this.followActiveCell = !this.followActiveCell;
    void vscode.workspace
      .getConfiguration()
      .update("notebookPreview.followActiveCell", this.followActiveCell, vscode.ConfigurationTarget.Global);

    this.postMessage({ type: "setConfig", followActiveCell: this.followActiveCell });
  }

  private pushIncrementalUpdate(event: vscode.NotebookDocumentChangeEvent): void {
    const document = event.notebook;
    const notebookDir = this.panel
      ? this.panel.webview.asWebviewUri(vscode.Uri.joinPath(document.uri, "..")).toString()
      : "";

    // No existing snapshot — do a full sync to establish baseline.
    if (!this.snapshot) {
      this.snapshot = buildSnapshot(document, 0);
      this.postMessage({ type: "fullSync", snapshot: this.snapshot, notebookDir });
      return;
    }

    // Structural changes (cells added / removed / reordered) — rebuild everything.
    // These are infrequent so a full sync is acceptable.
    if (event.contentChanges.length > 0) {
      this.snapshot = buildSnapshot(document, this.snapshot.docVersion);
      this.postMessage({ type: "fullSync", snapshot: this.snapshot, notebookDir });
      return;
    }

    // Cell-content-only changes: serialize only the cells that actually changed.
    // This is O(changed cells) instead of O(all cells), avoiding full re-serialization
    // of all image outputs on every keystroke.
    const ops: PatchOp[] = [];
    const nextVersion = this.snapshot.docVersion + 1;

    for (const change of event.cellChanges) {
      // Skip if neither source nor outputs changed (e.g. only metadata/executionSummary).
      if (change.document === undefined && change.outputs === undefined) {
        continue;
      }

      const id = change.cell.document.uri.toString();
      const nextCell: CellSnapshot = {
        id,
        kind: change.cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
        language: change.cell.document.languageId,
        source: change.cell.document.getText(),
        outputs: toOutputSnapshots(change.cell.outputs)
      };

      this.snapshot.cells[id] = nextCell;
      ops.push({ type: "recordCellSnapshot", id, cell: nextCell });
    }

    if (ops.length === 0) {
      return;
    }

    const baseVersion = this.snapshot.docVersion;
    this.snapshot.docVersion = nextVersion;
    this.postMessage({ type: "patch", baseVersion, docVersion: nextVersion, ops });
  }

  private handleWebviewMessage(message: WebviewToHostMessage): void {
    if (message.type === "requestFullSync") {
      this.refresh();
      return;
    }

    if (message.type === "toggleFollowActiveCell") {
      this.toggleFollowActiveCell();
      return;
    }

    if (message.type === "focusCell") {
      const editor = vscode.window.activeNotebookEditor;
      if (!editor || !this.snapshot) {
        return;
      }

      const index = this.snapshot.cellOrder.indexOf(message.id);
      if (index < 0) {
        return;
      }

      const range = new vscode.NotebookRange(index, index + 1);
      editor.selections = [range];
      editor.revealRange(range);
      return;
    }

    if (message.type === "ack") {
      this.statusBar.text = `Notebook Preview: Synced v${message.docVersion}`;
      return;
    }

    if (message.type === "openInBrowser") {
      this.openInBrowser(message.renderedHtml);
      return;
    }
  }

  private openInBrowser(renderedHtml: string): void {
    const cssPath = vscode.Uri.joinPath(this.extensionUri, "media", "styles.css").fsPath;
    const css = fs.readFileSync(cssPath, "utf8");

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css" />
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/github.min.css" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;0,700;1,400;1,600&display=swap" />
  <style>
${css}
  </style>
  <style>
    body { margin: 0; }
    .toolbar { display: none; }
    .cell.active { border-color: var(--border); box-shadow: none; }
    .cell-markdown.active { border-color: transparent; background: transparent; }
    @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
  </style>
  <title>Notebook Preview</title>
</head>
<body>
  <main>
    <section class="cell-list" aria-label="Notebook preview cells">
${renderedHtml}
    </section>
  </main>
</body>
</html>`;

    const tmpFile = path.join(os.tmpdir(), `notebook-preview-${Date.now()}.html`);
    fs.writeFileSync(tmpFile, html, "utf8");
    void vscode.env.openExternal(vscode.Uri.file(tmpFile));
  }

  private postMessage(message: HostToWebviewMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  private getPanelTitle(uri?: vscode.Uri): string {
    const activeUri = uri ?? vscode.window.activeNotebookEditor?.notebook.uri;
    if (!activeUri) {
      return "Notebook Preview";
    }

    return `Preview: ${vscode.workspace.asRelativePath(activeUri, false)}`;
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "styles.css"));
    const katexScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "katex.min.js"));
    const katexStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "katex.min.css"));
    const hlScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "highlight.min.js"));
    const hlStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "highlight-github.min.css"));
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: https:; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src ${webview.cspSource} https://fonts.gstatic.com; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${katexStyleUri}" />
  <link rel="stylesheet" href="${hlStyleUri}" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;0,700;1,400;1,600&display=swap" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Notebook Preview</title>
</head>
<body>
  <header class="toolbar">
    <button id="refreshButton" type="button" title="Refresh preview">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
        <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
      </svg>
    </button>
    <button id="toggleFollowButton" type="button" title="Toggle follow active cell" aria-pressed="${this.followActiveCell}">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/>
        <circle cx="8" cy="8" r="2"/>
      </svg>
    </button>
    <span id="statusText">Idle</span>
    <button id="openInBrowserButton" type="button" title="Open in browser for printing">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M8.636 3.5a.5.5 0 0 0-.5-.5H1.5A1.5 1.5 0 0 0 0 4.5v10A1.5 1.5 0 0 0 1.5 16h10a1.5 1.5 0 0 0 1.5-1.5V7.864a.5.5 0 0 0-1 0V14.5a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5h6.636a.5.5 0 0 0 .5-.5z"/>
        <path d="M16 .5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0 0 1h3.793L6.146 9.146a.5.5 0 1 0 .708.708L15 1.707V5.5a.5.5 0 0 0 1 0v-5z"/>
      </svg>
    </button>
  </header>
  <main>
    <section id="emptyState" class="empty-state">Open a notebook to preview cells.</section>
    <section id="cellList" class="cell-list" aria-label="Notebook preview cells"></section>
  </main>
  <script nonce="${nonce}" src="${katexScriptUri}"></script>
  <script nonce="${nonce}" src="${hlScriptUri}"></script>
  <script nonce="${nonce}">
    window.__NOTEBOOK_PREVIEW_CONFIG__ = {
      followActiveCell: ${this.followActiveCell ? "true" : "false"}
    };
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function buildMarkdownSnapshot(document: vscode.TextDocument, prevVersion: number): NotebookSnapshot {
  const id = document.uri.toString();
  const cell: CellSnapshot = {
    id,
    kind: "markdown",
    language: "markdown",
    source: document.getText(),
    outputs: []
  };
  return {
    docVersion: prevVersion + 1,
    activeCellId: id,
    cellOrder: [id],
    cells: { [id]: cell }
  };
}

function buildSnapshot(document: vscode.NotebookDocument, prevVersion: number): NotebookSnapshot {
  const cells: Record<string, CellSnapshot> = {};
  const order: string[] = [];

  document.getCells().forEach((cell) => {
    const id = cell.document.uri.toString();
    order.push(id);

    cells[id] = {
      id,
      kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
      language: cell.document.languageId,
      source: cell.document.getText(),
      outputs: toOutputSnapshots(cell.outputs)
    };
  });

  const activeSelection = vscode.window.activeNotebookEditor?.selections[0];
  const activeCellId = activeSelection ? order[activeSelection.start] : undefined;

  return {
    docVersion: prevVersion + 1,
    activeCellId,
    cellOrder: order,
    cells
  };
}

function toOutputSnapshots(outputs: readonly vscode.NotebookCellOutput[]): OutputSnapshot[] {
  const list: OutputSnapshot[] = [];
  for (const output of outputs) {
    for (const item of output.items) {
      if (
        item.mime === "text/plain" ||
        item.mime === "text/markdown" ||
        item.mime === "text/html" ||
        item.mime === "application/vnd.code.notebook.stdout" ||
        item.mime === "application/vnd.code.notebook.stderr"
      ) {
        list.push({
          mime: item.mime,
          text: decodeOutputText(item)
        });
        continue;
      }

      if (item.mime === "application/vnd.code.notebook.error") {
        list.push({
          mime: item.mime,
          text: formatNotebookError(decodeOutputText(item))
        });
        continue;
      }

      if (item.mime === "application/json" || item.mime === "application/ld+json") {
        list.push({
          mime: item.mime,
          text: formatJsonOutput(decodeOutputText(item))
        });
        continue;
      }

      if (item.mime === "image/png" || item.mime === "image/jpeg" || item.mime === "image/svg+xml") {
        const base64 = Buffer.from(item.data).toString("base64");
        list.push({
          mime: item.mime,
          dataUri: `data:${item.mime};base64,${base64}`
        });
      }
    }
  }

  return list;
}

function decodeOutputText(item: vscode.NotebookCellOutputItem): string {
  try {
    return TEXT_DECODER.decode(item.data);
  } catch {
    return "[Unsupported text output payload]";
  }
}

function formatNotebookError(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { name?: string; message?: string; stack?: string };
    const header = [parsed.name, parsed.message].filter(Boolean).join(": ");
    if (parsed.stack) {
      return `${header}\n${parsed.stack}`.trim();
    }

    return header || raw;
  } catch {
    return raw;
  }
}

function formatJsonOutput(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function hasCellChanged(a: CellSnapshot, b: CellSnapshot): boolean {
  return (
    a.source !== b.source ||
    a.kind !== b.kind ||
    a.language !== b.language ||
    JSON.stringify(a.outputs) !== JSON.stringify(b.outputs)
  );
}

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

const TEXT_DECODER = new TextDecoder();
