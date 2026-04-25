import * as vscode from "vscode";
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

      this.pushIncrementalUpdate(event.notebook);
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
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
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
    const editor = vscode.window.activeNotebookEditor;
    if (!editor) {
      this.snapshot = undefined;
      this.statusBar.text = "Notebook Preview: No Active Notebook";
      if (this.panel) {
        this.panel.title = this.getPanelTitle();
      }
      this.postMessage({ type: "status", text: "No active notebook editor." });
      return;
    }

    this.snapshot = buildSnapshot(editor.notebook, this.snapshot?.docVersion ?? 0);
    this.statusBar.text = "Notebook Preview: Connected";
    if (this.panel) {
      this.panel.title = this.getPanelTitle(editor.notebook.uri);
    }
    this.postMessage({ type: "fullSync", snapshot: this.snapshot });
  }

  toggleFollowActiveCell(): void {
    this.followActiveCell = !this.followActiveCell;
    void vscode.workspace
      .getConfiguration()
      .update("notebookPreview.followActiveCell", this.followActiveCell, vscode.ConfigurationTarget.Global);

    this.postMessage({
      type: "status",
      text: this.followActiveCell ? "Follow active cell enabled." : "Follow active cell disabled."
    });
  }

  private pushIncrementalUpdate(document: vscode.NotebookDocument): void {
    const nextSnapshot = buildSnapshot(document, this.snapshot?.docVersion ?? 0);

    if (!this.snapshot) {
      this.snapshot = nextSnapshot;
      this.postMessage({ type: "fullSync", snapshot: nextSnapshot });
      return;
    }

    const patch = computePatch(this.snapshot, nextSnapshot);
    if (!patch) {
      this.snapshot = nextSnapshot;
      this.postMessage({ type: "fullSync", snapshot: nextSnapshot });
      return;
    }

    this.snapshot = nextSnapshot;
    this.postMessage({
      type: "patch",
      baseVersion: patch.baseVersion,
      docVersion: patch.docVersion,
      ops: patch.ops
    });
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

      const index = this.snapshot.cellOrder.findIndex((id) => id === message.id);
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
    }
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
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${katexStyleUri}" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Notebook Preview</title>
</head>
<body>
  <header class="toolbar">
    <button id="refreshButton" type="button">Refresh</button>
    <button id="toggleFollowButton" type="button">Toggle Follow</button>
    <span id="statusText">Idle</span>
  </header>
  <main>
    <section id="emptyState" class="empty-state">Open a notebook to preview cells.</section>
    <section id="cellList" class="cell-list" aria-label="Notebook preview cells"></section>
  </main>
  <script nonce="${nonce}" src="${katexScriptUri}"></script>
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
    return new TextDecoder().decode(item.data);
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

function computePatch(
  previous: NotebookSnapshot,
  next: NotebookSnapshot
): { baseVersion: number; docVersion: number; ops: PatchOp[] } | undefined {
  const ops: PatchOp[] = [];

  const previousIds = new Set(previous.cellOrder);
  const nextIds = new Set(next.cellOrder);

  const deleted = previous.cellOrder.filter((id) => !nextIds.has(id));
  if (deleted.length > 0) {
    ops.push({ type: "deleteCells", ids: deleted });
  }

  const inserted = next.cellOrder
    .map((id, index) => ({ id, index }))
    .filter((entry) => !previousIds.has(entry.id));

  for (const entry of inserted) {
    ops.push({
      type: "insertCells",
      at: entry.index,
      cells: [next.cells[entry.id]]
    });
  }

  if (deleted.length === 0 && inserted.length === 0 && !isSameOrder(previous.cellOrder, next.cellOrder)) {
    return undefined;
  }

  for (const id of next.cellOrder) {
    if (!previous.cells[id] || !next.cells[id]) {
      continue;
    }

    if (hasCellChanged(previous.cells[id], next.cells[id])) {
      ops.push({
        type: "recordCellSnapshot",
        id,
        cell: next.cells[id]
      });
    }
  }

  if (previous.activeCellId !== next.activeCellId) {
    ops.push({ type: "setActiveCell", id: next.activeCellId });
  }

  return {
    baseVersion: previous.docVersion,
    docVersion: next.docVersion,
    ops
  };
}

function hasCellChanged(a: CellSnapshot, b: CellSnapshot): boolean {
  return (
    a.source !== b.source ||
    a.kind !== b.kind ||
    a.language !== b.language ||
    JSON.stringify(a.outputs) !== JSON.stringify(b.outputs)
  );
}

function isSameOrder(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";

  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return nonce;
}
