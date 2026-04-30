import * as vscode from "vscode";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import * as child_process from "child_process";
import { CellSnapshot, NotebookSnapshot, OutputSnapshot } from "./protocol";
import { snapshotToTypst, collectCitationKeys } from "./typstConverter";
import { fetchDoiBib, fetchArxivBib, BibEntry, httpsGetBuffer } from "./bibFetch";

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
  private bibCache = new Map<string, BibEntry>();
  /** url → local filename in tmpDir, or "" for a failed download */
  private imageCache = new Map<string, string>();
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
      void this.writeDocument();
      return;
    }

    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nbpreview-typst-"));
    this.lastTypContent = undefined;
    this.bibCache = new Map();
    this.imageCache = new Map();

    this.panel = vscode.window.createWebviewPanel(
      "scholarPreview.typst",
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
      if (msg.type === "recompile") { this.lastTypContent = undefined; void this.writeDocument(); }
      if (msg.type === "downloadTyp") { void this.downloadTyp(); }
      if (msg.type === "downloadBib") { void this.downloadBib(); }
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
    this.writeDebounce = setTimeout(() => { void this.writeDocument(); }, 600);
  }

  /** Write document.typ (and refs.bib) — typst watch detects the change and recompiles. */
  private async writeDocument(): Promise<void> {
    if (!this.panel || !this.tmpDir) { return; }

    const snapshot = this.buildCurrentSnapshot();
    const typFile = path.join(this.tmpDir, "document.typ");

    if (!snapshot) {
      void this.panel.webview.postMessage({ type: "empty" });
      return;
    }
    // Download remote images referenced in markdown cells
    await this.resolveRemoteImages(snapshot);
    // Collect @arxiv:ID / @doi:ID citations and fetch any we haven’t seen yet
    const citations = collectCitationKeys(snapshot);
    const newlyFailed: string[] = [];
    if (citations.length > 0) {
      await Promise.all(
        citations
          .filter(c => !this.bibCache.has(c.key))
          .map(async c => {
            try {
              const entry = c.type === "doi"
                ? await fetchDoiBib(c.id)
                : await fetchArxivBib(c.id);
              this.bibCache.set(c.key, entry);
            } catch (err) {
              console.warn(`[notebook-preview] bibFetch failed for ${c.key}:`, err);
              // Cache a stub so Typst compiles and we don't retry on every keystroke
              const stub: BibEntry = {
                cite: c.id,
                linkLabel: c.id,
                bibtex: `@misc{${c.key},\n  title = {[Not found: ${c.id}]},\n  note  = {Fetch failed: ${String(err).slice(0, 120)}}\n}`,
              };
              this.bibCache.set(c.key, stub);
              newlyFailed.push(`${c.type === "doi" ? "doi" : "arxiv"}:${c.id}`);
            }
          })
      );
    }
    if (newlyFailed.length > 0) {
      void vscode.window.showWarningMessage(
        `Bibliography fetch failed for: ${newlyFailed.join(", ")}. Check the ID and your internet connection.`
      );
    }

    // Write refs.bib with all available entries (typst watch picks up changes automatically)
    const bibEntries = citations
      .filter(c => this.bibCache.has(c.key))
      .map(c => this.bibCache.get(c.key)!.bibtex);
    const hasBib = bibEntries.length > 0;
    if (hasBib && this.tmpDir) {
      fs.writeFileSync(path.join(this.tmpDir, "refs.bib"), bibEntries.join("\n\n"), "utf8");
    }

    let typContent: string;
    try {
      typContent = snapshotToTypst(snapshot, this.tmpDir);
      if (hasBib) {
        typContent += '\n#bibliography("refs.bib", style: "ieee")\n';
      }
    } catch (err) {
      void this.panel.webview.postMessage({ type: "error", message: String(err) });
      return;
    }

    // Skip write if content is unchanged — typst watch won’t recompile and
    // no SVG event will fire, leaving the toolbar stuck on “Compiling…”.
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
    setTimeout(() => { void this.writeDocument(); }, 300);
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

  /** Download all remote image URLs found in markdown cells to tmpDir and rewrite cell sources. */
  private async resolveRemoteImages(snapshot: NotebookSnapshot): Promise<void> {
    if (!this.tmpDir) { return; }
    const tmpDir = this.tmpDir;
    const remoteRe = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;
    for (const id of snapshot.cellOrder) {
      const cell = snapshot.cells[id];
      if (!cell || cell.kind !== "markdown") { continue; }
      const urls = [...cell.source.matchAll(remoteRe)].map(m => m[2]);
      for (const url of urls) {
        if (this.imageCache.has(url)) { continue; }
        try {
          const extMatch = url.match(/\.(png|jpe?g|gif|webp|svg)(\?|$)/i);
          const ext = extMatch ? extMatch[1].toLowerCase().replace("jpeg", "jpg") : "png";
          const hash = crypto.createHash("sha1").update(url).digest("hex").slice(0, 12);
          const fname = `img_${hash}.${ext}`;
          const buf = await httpsGetBuffer(url);
          fs.writeFileSync(path.join(tmpDir, fname), buf);
          this.imageCache.set(url, fname);
        } catch (err) {
          console.warn(`[notebook-preview] image download failed for ${url}:`, err);
          this.imageCache.set(url, ""); // empty = failed, don't retry
        }
      }
      // Rewrite remote URLs to local filenames in the cell source
      snapshot.cells[id] = {
        ...cell,
        source: cell.source.replace(
          /(!\[([^\]]*)\])\((https?:\/\/[^)]+)\)/g,
          (match, altPart, _alt, url) => {
            const fname = this.imageCache.get(url);
            if (!fname) { return `[Image not available: ${_alt || url}]`; }
            return `${altPart}(${fname})`;
          }
        ),
      };
    }
  }

  private async downloadBib(): Promise<void> {
    if (!this.tmpDir) { return; }
    const bibFile = path.join(this.tmpDir, "refs.bib");
    if (!fs.existsSync(bibFile)) {
      void vscode.window.showErrorMessage("No bibliography yet \u2014 add @arxiv: or @doi: citations first.");
      return;
    }
    const dest = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "refs.bib")),
      filters: { "BibTeX bibliography": ["bib"] },
      title: "Save bibliography",
    });
    if (!dest) { return; }
    fs.copyFileSync(bibFile, dest.fsPath);
    void vscode.window.showInformationMessage(`Saved: ${dest.fsPath}`);
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
    <div class="dropdown">
      <button id="downloadMenuBtn" type="button" title="Download\u2026" aria-haspopup="true" aria-expanded="false">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M.5 9.9a.5.5 0 0 1 .5.5v2.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2.5a.5.5 0 0 1 1 0v2.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2v-2.5a.5.5 0 0 1 .5-.5z"/>
          <path d="M7.646 11.854a.5.5 0 0 0 .708 0l3-3a.5.5 0 0 0-.708-.708L8.5 10.293V1.5a.5.5 0 0 0-1 0v8.793L5.354 8.146a.5.5 0 1 0-.708.708l3 3z"/>
        </svg>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" style="margin-left:1px;flex-shrink:0">
          <path d="M7.247 11.14 2.451 5.658C1.885 5.013 2.345 4 3.204 4h9.592a1 1 0 0 1 .753 1.659l-4.796 5.48a1 1 0 0 1-1.506 0z"/>
        </svg>
      </button>
      <ul class="dropdown-menu" role="menu" hidden>
        <li><button data-action="exportPdf" role="menuitem">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M14 14V4.5L9.5 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2zM9.5 3A1.5 1.5 0 0 0 11 4.5h2V9H3V2a1 1 0 0 1 1-1h5.5v2z"/>
          </svg>
          Export PDF
        </button></li>
        <li><button data-action="downloadTyp" role="menuitem">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M9.293 0H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4.707L9.293 0zM9.5 3.5v-2l3 3h-2A1 1 0 0 1 9.5 3.5z"/>
          </svg>
          Download .typ
        </button></li>
        <li><button data-action="downloadBib" role="menuitem">
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M1 2.828c.885-.37 2.154-.769 3.388-.893 1.33-.134 2.458.063 3.112.752v9.746c-.935-.53-2.12-.603-3.213-.493-1.18.12-2.37.461-3.287.811zm7.5-.141c.654-.689 1.782-.886 3.112-.752 1.234.124 2.503.523 3.388.893v9.923c-.918-.35-2.107-.692-3.287-.81-1.094-.111-2.278-.039-3.213.492zM8 1.783C7.015.936 5.587.81 4.287.94c-1.514.153-3.042.672-3.994 1.105A.5.5 0 0 0 0 2.5v11a.5.5 0 0 0 .707.455c.882-.4 2.303-.881 3.68-1.02 1.409-.142 2.59.087 3.223.877a.5.5 0 0 0 .78 0c.633-.79 1.814-1.019 3.222-.877 1.378.139 2.8.62 3.681 1.02A.5.5 0 0 0 16 13.5v-11a.5.5 0 0 0-.293-.455c-.952-.433-2.48-.952-3.994-1.105C10.413.809 8.985.936 8 1.783"/>
          </svg>
          Download .bib
        </button></li>
      </ul>
    </div>
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
