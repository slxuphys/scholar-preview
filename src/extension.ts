import * as vscode from "vscode";
import { NotebookPreviewViewProvider } from "./previewViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new NotebookPreviewViewProvider(context.extensionUri);
  context.subscriptions.push(provider); // ensures dispose() is called on deactivation

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
}

export function deactivate(): void {
  // No-op.
}
