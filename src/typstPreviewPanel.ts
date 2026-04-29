import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as child_process from "child_process";
import { CellSnapshot, NotebookSnapshot, OutputSnapshot } from "./protocol";
import { snapshotToTypst } from "./typstConverter";

const TEXT_DECODER = new TextDecoder("utf-8");

export class TypstPreviewPanel {
  private panel?: vscode.WebviewPanel;
  private tmpDir?: string;
  private watchProcess?: child_process.ChildProcess;
  private dirWatcher?: fs.FSWatcher;
  private writeDebounce?: ReturnType<typeof setTimeout>;
  private pagesDebounce?: ReturnType<typeof setTimeout>;
  private compileDeadline?: ReturnType<typeof setTimeout>;
  private errorDebounce?: ReturnType<typeof setTimeout>;
  private errorLines: string[] = [];
  private lastTypContent?: string;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {
    this.disposables.push(
      vscode.workspace.onDidChangeNotebookDocument(() => this.scheduleWrite())
    );
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (
          e.document.languageId === "markdown" &&
          e.document.uri.scheme !== "vscode-notebook-cell"
        ) {
          this.scheduleWrite();
        }
      })
    );
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      this.writeDocument();
      return;
    }

    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nbpreview-typst-"));
    this.lastTypContent = undefined;

    this.panel = vscode.window.createWebviewPanel(
      "notebookPreview.typst",
      "Typst Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "exportPdf") { this.exportPdf(); }
      if (msg.type === "recompile") { this.writeDocument(); }
      if (msg.type === "downloadTyp") { void this.downloadTyp(); }
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.stopWatch();
      this.cleanupTmpDir();
    });

    this.startWatch();
  }

  dispose(): void {
    if (this.writeDebounce) { clearTimeout(this.writeDebounce); }
    if (this.pagesDebounce) { clearTimeout(this.pagesDebounce); }
    if (this.compileDeadline) { clearTimeout(this.compileDeadline); }
    if (this.errorDebounce) { clearTimeout(this.errorDebounce); }
    this.panel?.dispose();
    this.stopWatch();
    this.cleanupTmpDir();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }

  private scheduleWrite(): void {
    if (!this.panel) { return; }
    if (this.writeDebounce) { clearTimeout(this.writeDebounce); }
    this.writeDebounce = setTimeout(() => this.writeDocument(), 600);
  }

  /** Write document.typ — typst watch detects the change and recompiles. */
  private writeDocument(): void {
    if (!this.panel || !this.tmpDir) { return; }

    const snapshot = this.buildCurrentSnapshot();
    const typFile = path.join(this.tmpDir, "document.typ");

    if (!snapshot) {
      void this.panel.webview.postMessage({ type: "empty" });
      return;
    }

    let typContent: string;
    try {
      typContent = snapshotToTypst(snapshot, this.tmpDir);
    } catch (err) {
      void this.panel.webview.postMessage({ type: "error", message: String(err) });
      return;
    }

    // Skip write if content is unchanged — typst watch won't recompile and
    // no SVG event will fire, leaving the toolbar stuck on "Compiling…".
    if (typContent === this.lastTypContent) { return; }
    this.lastTypContent = typContent;

    void this.panel.webview.postMessage({ type: "compiling" });
    // Safety net: if typst produces no output and no error within 30s, surface a message
    if (this.compileDeadline) { clearTimeout(this.compileDeadline); }
    this.compileDeadline = setTimeout(() => {
      void this.panel?.webview.postMessage({
        type: "error",
        message: "Typst did not respond within 30 seconds. Check that typst is on your PATH.",
      });
    }, 30000);
    fs.writeFileSync(typFile, typContent, "utf8");
    // typst watch picks up the change and recompiles automatically
  }

  /** Spawn `typst watch document.typ page_{p}.svg` and watch the tmpDir with
   *  fs.watch for SVG changes (robust against typst output format changes).
   *  Stderr is still parsed for error messages. */
  private startWatch(): void {
    if (!this.tmpDir) { return; }

    const typFile = path.join(this.tmpDir, "document.typ");
    // Placeholder so typst watch can start without an immediate parse error
    fs.writeFileSync(typFile, "#set page(paper: \"a4\")\n", "utf8");

    const svgTemplate = path.join(this.tmpDir, "page_{p}.svg");

    this.watchProcess = child_process.spawn(
      "typst",
      ["watch", typFile, svgTemplate],
      { cwd: this.tmpDir }
    );

    this.watchProcess.on("error", (err) => {
      void this.panel?.webview.postMessage({
        type: "error",
        message: `Failed to start typst: ${err.message}\n\nMake sure typst is installed and on your PATH.`,
      });
    });

    this.watchProcess.on("exit", (code) => {
      if (code !== null && code !== 0 && this.panel) {
        void this.panel.webview.postMessage({
          type: "error",
          message: `typst watch exited with code ${code}`,
        });
      }
    });

    // Watch filesystem for SVG output changes — this fires whenever typst
    // successfully writes a page file, regardless of typst's log format.
    this.dirWatcher = fs.watch(this.tmpDir, (_event, filename) => {
      if (!filename?.startsWith("page_") || !filename.endsWith(".svg")) { return; }
      // Debounce: multiple pages are written in quick succession
      if (this.pagesDebounce) { clearTimeout(this.pagesDebounce); }
      this.pagesDebounce = setTimeout(() => {
        this.sendPages();
      }, 80);
    });
    this.dirWatcher.on("error", () => { /* ignore watcher errors on cleanup */ });

    // Parse stderr only to surface error messages to the user
    let lineBuf = "";
    this.errorLines = [];
    const ANSI_RE = /\x1b\[[0-9;]*m/g;

    const handleData = (data: Buffer) => {
      lineBuf += data.toString();
      const lines = lineBuf.split(/\r?\n/);
      lineBuf = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.replace(ANSI_RE, "");
        const lower = line.toLowerCase();
        // Clear accumulated errors when a successful compile is reported
        if (lower.includes("compiled") && !lower.startsWith("error") && !lower.includes(": error")) {
          this.errorLines = [];
          if (this.errorDebounce) { clearTimeout(this.errorDebounce); this.errorDebounce = undefined; }
          return;
        }
        // Collect error blocks (ignore warnings and download progress lines)
        if (lower.startsWith("error") || lower.includes(": error") ||
            (this.errorLines.length > 0 && line.trim() && !lower.startsWith("warning") &&
             !lower.startsWith("downloading") && !lower.startsWith("watching") &&
             !lower.startsWith("writing"))) {
          this.errorLines.push(line);
          // Debounce error reporting so we accumulate the full block
          if (this.errorDebounce) { clearTimeout(this.errorDebounce); }
          this.errorDebounce = setTimeout(() => {
            if (this.errorLines.length > 0) {
              if (this.compileDeadline) { clearTimeout(this.compileDeadline); this.compileDeadline = undefined; }
              void this.panel?.webview.postMessage({
                type: "error",
                message: this.errorLines.join("\n").slice(0, 3000),
              });
            }
          }, 200);
        }
      }
    };

    this.watchProcess.stderr?.on("data", handleData);
    this.watchProcess.stdout?.on("data", handleData);

    // Write real content after watch has initialised its file watcher
    setTimeout(() => this.writeDocument(), 300);
  }

  private stopWatch(): void {
    this.dirWatcher?.close();
    this.dirWatcher = undefined;
    if (this.watchProcess) {
      this.watchProcess.kill();
      this.watchProcess = undefined;
    }
  }

  private sendPages(): void {
    if (!this.panel || !this.tmpDir) { return; }

    const files = fs
      .readdirSync(this.tmpDir)
      .filter((f) => f.startsWith("page_") && f.endsWith(".svg"))
      .sort((a, b) => {
        const na = parseInt(a.match(/page_(\d+)\.svg/)?.[1] ?? "0", 10);
        const nb = parseInt(b.match(/page_(\d+)\.svg/)?.[1] ?? "0", 10);
        return na - nb;
      });

    const pages = files.map((f) => {
      const buf = fs.readFileSync(path.join(this.tmpDir!, f));
      return "data:image/svg+xml;base64," + buf.toString("base64");
    });

    if (pages.length === 0) {
      // Race: typst deleted old SVGs but hasn't written new ones yet.
      // Retry once after 500 ms before giving up (compile deadline will fire if truly stuck).
      if (!this.pagesDebounce) {
        this.pagesDebounce = setTimeout(() => {
          this.pagesDebounce = undefined;
          this.sendPages();
        }, 500);
      }
      return;
    }

    // Successful compile — discard any pending error state
    this.errorLines = [];
    if (this.errorDebounce) { clearTimeout(this.errorDebounce); this.errorDebounce = undefined; }
    if (this.compileDeadline) { clearTimeout(this.compileDeadline); this.compileDeadline = undefined; }
    void this.panel.webview.postMessage({ type: "showPages", pages });
  }

  private async downloadTyp(): Promise<void> {
    if (!this.tmpDir) { return; }
    const typFile = path.join(this.tmpDir, "document.typ");
    if (!fs.existsSync(typFile)) {
      void vscode.window.showErrorMessage("No source file yet — compile first.");
      return;
    }
    const dest = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "document.typ")),
      filters: { "Typst source": ["typ"] },
      title: "Save Typst source",
    });
    if (!dest) { return; }
    fs.copyFileSync(typFile, dest.fsPath);
    void vscode.window.showInformationMessage(`Saved: ${dest.fsPath}`);
  }

  private exportPdf(): void {
    if (!this.tmpDir) { return; }

    const typFile = path.join(this.tmpDir, "document.typ");
    if (!fs.existsSync(typFile)) {
      void vscode.window.showErrorMessage("Compile the document first.");
      return;
    }

    const pdfFile = path.join(this.tmpDir, "document.pdf");
    const q = (p: string) => `"${p.replace(/"/g, '\\"')}"`;
    const cmd = `typst compile ${q(typFile)} ${q(pdfFile)}`;

    child_process.exec(cmd, { cwd: this.tmpDir }, (err, _stdout, stderr) => {
      if (err) {
        void vscode.window.showErrorMessage(
          `Typst PDF export failed: ${(stderr || String(err)).slice(0, 500)}`
        );
        return;
      }
      void vscode.env.openExternal(vscode.Uri.file(pdfFile));
    });
  }

  private cleanupTmpDir(): void {
    if (this.tmpDir) {
      try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      this.tmpDir = undefined;
    }
  }

  private buildCurrentSnapshot(): NotebookSnapshot | null {
    const textEditor = vscode.window.activeTextEditor;
    if (
      textEditor?.document.languageId === "markdown" &&
      textEditor.document.uri.scheme !== "vscode-notebook-cell"
    ) {
      const id = textEditor.document.uri.toString();
      return {
        docVersion: 1,
        cellOrder: [id],
        cells: {
          [id]: {
            id,
            kind: "markdown",
            language: "markdown",
            source: textEditor.document.getText(),
            outputs: [],
          },
        },
      };
    }

    const editor = vscode.window.activeNotebookEditor;
    if (!editor) { return null; }

    const cells: Record<string, CellSnapshot> = {};
    const cellOrder: string[] = [];

    for (const cell of editor.notebook.getCells()) {
      const id = cell.document.uri.toString();
      cellOrder.push(id);
      cells[id] = {
        id,
        kind: cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code",
        language: cell.document.languageId,
        source: cell.document.getText(),
        outputs: extractOutputs(cell.outputs),
      };
    }

    return { docVersion: 1, cellOrder, cells };
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "typst-preview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "typst-preview.css")
    );
    const nonce = crypto.randomBytes(16).toString("base64");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Typst Preview</title>
</head>
<body>
  <header class="toolbar">
    <button id="recompileBtn" type="button" title="Recompile">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
        <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
      </svg>
    </button>
    <button id="exportPdfBtn" type="button" title="Export PDF">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
        <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
      </svg>
    </button>
    <button id="downloadTypBtn" type="button" title="Download Typst source (.typ)">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M4.406 1.342A5.53 5.53 0 0 1 8 0c2.69 0 4.923 2 5.166 4.579C14.758 4.804 16 6.137 16 7.773 16 9.569 14.502 11 12.687 11H10a.5.5 0 0 1 0-1h2.688C13.979 10 15 8.988 15 7.773c0-1.216-1.02-2.228-2.313-2.228h-.5v-.5C12.188 2.825 10.328 1 8 1a4.53 4.53 0 0 0-2.941 1.1c-.757.652-1.153 1.438-1.153 2.055v.448l-.445.049C2.064 4.805 1 5.952 1 7.318 1 8.785 2.23 10 3.781 10H6a.5.5 0 0 1 0 1H3.781C1.708 11 0 9.366 0 7.318c0-1.763 1.266-3.223 2.942-3.524A3.6 3.6 0 0 1 4.406 1.342"/>
        <path d="M7.646 15.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 14.293V5.5a.5.5 0 0 0-1 0v8.793l-2.146-2.147a.5.5 0 0 0-.708.708z"/>
      </svg>
    </button>
    <span id="statusText"></span>
  </header>
  <div id="viewer"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function extractOutputs(outputs: readonly vscode.NotebookCellOutput[]): OutputSnapshot[] {
  const list: OutputSnapshot[] = [];
  for (const output of outputs) {
    for (const item of output.items) {
      if (
        item.mime === "text/plain" ||
        item.mime === "application/vnd.code.notebook.stdout" ||
        item.mime === "application/vnd.code.notebook.stderr" ||
        item.mime === "application/vnd.code.notebook.error"
      ) {
        try {
          list.push({ mime: item.mime, text: TEXT_DECODER.decode(item.data) });
        } catch { /* skip */ }
        break; // one text output per output bundle
      } else if (
        item.mime === "image/png" ||
        item.mime === "image/jpeg" ||
        item.mime === "image/svg+xml"
      ) {
        const base64 = Buffer.from(item.data).toString("base64");
        list.push({ mime: item.mime, dataUri: `data:${item.mime};base64,${base64}` });
        break; // prefer first image
      }
    }
  }
  return list;
}
