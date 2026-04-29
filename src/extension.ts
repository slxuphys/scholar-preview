import * as vscode from "vscode";
import { NotebookPreviewViewProvider } from "./previewViewProvider";
import { TypstPreviewPanel } from "./typstPreviewPanel";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new NotebookPreviewViewProvider(context.extensionUri);
  context.subscriptions.push(provider);

  const typstPanel = new TypstPreviewPanel(context.extensionUri);
  context.subscriptions.push(typstPanel);

  context.subscriptions.push(
    vscode.commands.registerCommand("notebookPreview.openSidepanePreview", async () => {
      await provider.open();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("notebookPreview.refreshPreview", () => {
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("notebookPreview.toggleFollowActiveCell", () => {
      provider.toggleFollowActiveCell();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("notebookPreview.openTypstPreview", () => {
      typstPanel.open();
    })
  );
}

export function deactivate(): void {
  // No-op.
}
