import * as vscode from "vscode";

/**
 * Obsidian-style syntax highlighting for the editor.
 * Decorates wikilinks, tags, dataview blocks, embeds, and highlights.
 */
export class EditorDecorator {
  private disposables: vscode.Disposable[] = [];
  private enabled: boolean = false;

  // Decoration types
  private wikilinkDecoration: vscode.TextEditorDecorationType;
  private tagDecoration: vscode.TextEditorDecorationType;
  private embedDecoration: vscode.TextEditorDecorationType;
  private highlightDecoration: vscode.TextEditorDecorationType;
  private dataviewBlockDecoration: vscode.TextEditorDecorationType;
  private codeBlockHeaderDecoration: vscode.TextEditorDecorationType;

  // Debounce timer
  private updateTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    // Wikilink: [[link]] - blue color
    this.wikilinkDecoration = vscode.window.createTextEditorDecorationType({
      color: "#0969da",
      textDecoration: "none",
    });

    // Tag: #tag - purple color
    this.tagDecoration = vscode.window.createTextEditorDecorationType({
      color: "#8250df",
    });

    // Embed: ![[embed]] - green color
    this.embedDecoration = vscode.window.createTextEditorDecorationType({
      color: "#1a7f37",
    });

    // Highlight: ==text== - yellow background
    this.highlightDecoration = vscode.window.createTextEditorDecorationType({
      backgroundColor: "rgba(255, 235, 59, 0.4)",
      borderRadius: "2px",
    });

    // Dataview/code block content - subtle gray background
    this.dataviewBlockDecoration = vscode.window.createTextEditorDecorationType(
      {
        backgroundColor: "rgba(128, 128, 128, 0.1)",
        isWholeLine: true,
      }
    );

    // Code block header (```dataview, ```ad-*, etc) - darker header
    this.codeBlockHeaderDecoration =
      vscode.window.createTextEditorDecorationType({
        backgroundColor: "rgba(128, 128, 128, 0.2)",
        isWholeLine: true,
      });
  }

  /**
   * Enable decorations when connected to Obsidian.
   */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;

    // Listen for active editor changes
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.languageId === "markdown") {
          this.updateDecorations(editor);
        }
      })
    );

    // Listen for document changes
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor;
        if (
          editor &&
          event.document === editor.document &&
          editor.document.languageId === "markdown"
        ) {
          this.scheduleUpdate(editor);
        }
      })
    );

    // Initial decoration for current editor
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "markdown") {
      this.updateDecorations(editor);
    }

    console.log("[Decorator] Enabled");
  }

  /**
   * Disable decorations.
   */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;

    // Clear all decorations
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.setDecorations(this.wikilinkDecoration, []);
      editor.setDecorations(this.tagDecoration, []);
      editor.setDecorations(this.embedDecoration, []);
      editor.setDecorations(this.highlightDecoration, []);
      editor.setDecorations(this.dataviewBlockDecoration, []);
      editor.setDecorations(this.codeBlockHeaderDecoration, []);
    }

    // Dispose listeners
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];

    console.log("[Decorator] Disabled");
  }

  /**
   * Debounced update to avoid performance issues.
   */
  private scheduleUpdate(editor: vscode.TextEditor): void {
    if (this.updateTimer) {
      clearTimeout(this.updateTimer);
    }
    this.updateTimer = setTimeout(() => {
      this.updateDecorations(editor);
    }, 100);
  }

  /**
   * Update all decorations for the given editor.
   */
  private updateDecorations(editor: vscode.TextEditor): void {
    if (!this.enabled) return;

    const document = editor.document;
    const text = document.getText();

    const wikilinks: vscode.DecorationOptions[] = [];
    const tags: vscode.DecorationOptions[] = [];
    const embeds: vscode.DecorationOptions[] = [];
    const highlights: vscode.DecorationOptions[] = [];
    const dataviewBlocks: vscode.DecorationOptions[] = [];
    const codeBlockHeaders: vscode.DecorationOptions[] = [];

    // Track code blocks to avoid decorating inside them
    const codeBlockRanges: Array<{ start: number; end: number }> = [];

    // Find all code blocks first
    const codeBlockRegex = /^```(\w*)\s*$/gm;
    let inCodeBlock = false;
    let codeBlockStart = 0;
    let codeBlockLang = "";
    let match: RegExpExecArray | null;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (!inCodeBlock) {
        // Start of code block
        inCodeBlock = true;
        codeBlockStart = match.index;
        codeBlockLang = match[1].toLowerCase();
      } else {
        // End of code block
        inCodeBlock = false;
        const codeBlockEnd = match.index + match[0].length;
        codeBlockRanges.push({ start: codeBlockStart, end: codeBlockEnd });

        // Decorate special code blocks (dataview, ad-*, etc)
        if (
          codeBlockLang === "dataview" ||
          codeBlockLang.startsWith("ad-") ||
          codeBlockLang === "tasks"
        ) {
          const startPos = document.positionAt(codeBlockStart);
          const endPos = document.positionAt(codeBlockEnd);

          // Header line
          codeBlockHeaders.push({
            range: new vscode.Range(startPos, startPos),
          });

          // Content lines (skip header and footer)
          for (
            let line = startPos.line + 1;
            line < endPos.line;
            line++
          ) {
            dataviewBlocks.push({
              range: new vscode.Range(line, 0, line, 0),
            });
          }

          // Footer line
          codeBlockHeaders.push({
            range: new vscode.Range(endPos.line, 0, endPos.line, 0),
          });
        }
      }
    }

    // Helper to check if position is inside a code block
    const isInCodeBlock = (pos: number): boolean => {
      return codeBlockRanges.some((r) => pos >= r.start && pos <= r.end);
    };

    // Find wikilinks: [[link]] or [[link|alias]]
    const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
    while ((match = wikilinkRegex.exec(text)) !== null) {
      if (isInCodeBlock(match.index)) continue;

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      wikilinks.push({
        range: new vscode.Range(startPos, endPos),
        hoverMessage: `Link to: ${match[1].split("|")[0]}`,
      });
    }

    // Find embeds: ![[embed]]
    const embedRegex = /!\[\[([^\]]+)\]\]/g;
    while ((match = embedRegex.exec(text)) !== null) {
      if (isInCodeBlock(match.index)) continue;

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      embeds.push({
        range: new vscode.Range(startPos, endPos),
        hoverMessage: `Embed: ${match[1]}`,
      });
    }

    // Find tags: #tag (but not inside links or at start of heading)
    const tagRegex = /(?<![[\w])#([\w\-_/]+)/g;
    while ((match = tagRegex.exec(text)) !== null) {
      if (isInCodeBlock(match.index)) continue;

      // Skip if it's a heading (# at start of line)
      const lineStart = text.lastIndexOf("\n", match.index) + 1;
      if (match.index === lineStart) continue;

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      tags.push({
        range: new vscode.Range(startPos, endPos),
      });
    }

    // Find highlights: ==text==
    const highlightRegex = /==((?:(?!==).)+)==/g;
    while ((match = highlightRegex.exec(text)) !== null) {
      if (isInCodeBlock(match.index)) continue;

      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      highlights.push({
        range: new vscode.Range(startPos, endPos),
      });
    }

    // Apply decorations
    editor.setDecorations(this.wikilinkDecoration, wikilinks);
    editor.setDecorations(this.tagDecoration, tags);
    editor.setDecorations(this.embedDecoration, embeds);
    editor.setDecorations(this.highlightDecoration, highlights);
    editor.setDecorations(this.dataviewBlockDecoration, dataviewBlocks);
    editor.setDecorations(this.codeBlockHeaderDecoration, codeBlockHeaders);
  }

  /**
   * Dispose all resources.
   */
  dispose(): void {
    this.disable();
    this.wikilinkDecoration.dispose();
    this.tagDecoration.dispose();
    this.embedDecoration.dispose();
    this.highlightDecoration.dispose();
    this.dataviewBlockDecoration.dispose();
    this.codeBlockHeaderDecoration.dispose();
  }
}
