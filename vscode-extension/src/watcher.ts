import * as vscode from "vscode";

type ContentChangeCallback = (filePath: string, content: string) => void;

export class EditorWatcher {
  private disposable: vscode.Disposable | null = null;
  private callbacks: ContentChangeCallback[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceMs = 300;

  start(): void {
    this.disposable = vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "markdown") return;
      if (event.contentChanges.length === 0) return;

      this.debounce(() => {
        const filePath = event.document.uri.fsPath;
        const content = event.document.getText();
        this.callbacks.forEach((cb) => cb(filePath, content));
      });
    });
  }

  stop(): void {
    this.disposable?.dispose();
    this.disposable = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
  }

  onContentChange(callback: ContentChangeCallback): void {
    this.callbacks.push(callback);
  }

  private debounce(fn: () => void): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(fn, this.debounceMs);
  }
}
