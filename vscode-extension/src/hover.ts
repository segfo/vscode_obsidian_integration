import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

/**
 * Provides hover preview for wikilinks in the editor.
 * Shows a preview of the linked file when hovering with Ctrl pressed.
 */
export class WikilinkHoverProvider implements vscode.HoverProvider {
  private enabled: boolean = false;

  enable(): void {
    this.enabled = true;
  }

  disable(): void {
    this.enabled = false;
  }

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token: vscode.CancellationToken
  ): Promise<vscode.Hover | null> {
    if (!this.enabled) return null;

    const line = document.lineAt(position.line).text;
    
    // Find wikilink at position: [[link]] or [[link|alias]]
    const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
    let match: RegExpExecArray | null;
    
    while ((match = wikilinkRegex.exec(line)) !== null) {
      const startCol = match.index;
      const endCol = match.index + match[0].length;
      
      if (position.character >= startCol && position.character <= endCol) {
        // Found wikilink at cursor position
        const linkContent = match[1];
        const linkTarget = linkContent.split("|")[0]; // Remove alias if present
        
        // Try to find the file
        const preview = await this.getFilePreview(document, linkTarget);
        
        if (preview) {
          const range = new vscode.Range(
            position.line, startCol,
            position.line, endCol
          );
          
          return new vscode.Hover(preview, range);
        }
      }
    }
    
    // Check for embeds: ![[embed]]
    const embedRegex = /!\[\[([^\]]+)\]\]/g;
    while ((match = embedRegex.exec(line)) !== null) {
      const startCol = match.index;
      const endCol = match.index + match[0].length;
      
      if (position.character >= startCol && position.character <= endCol) {
        const linkTarget = match[1].split("|")[0];
        const preview = await this.getFilePreview(document, linkTarget);
        
        if (preview) {
          const range = new vscode.Range(
            position.line, startCol,
            position.line, endCol
          );
          
          return new vscode.Hover(preview, range);
        }
      }
    }
    
    return null;
  }

  /**
   * Get preview content for a linked file.
   */
  private async getFilePreview(
    currentDocument: vscode.TextDocument,
    linkTarget: string
  ): Promise<vscode.MarkdownString | null> {
    // Skip same-file anchors
    if (linkTarget.startsWith("#")) {
      return null;
    }
    
    // Add .md extension if not present
    let searchPath = linkTarget.split("#")[0]; // Remove anchor part
    if (!searchPath) {
      return null; // Only anchor, no file part
    }
    if (!searchPath.endsWith(".md")) {
      searchPath = searchPath + ".md";
    }
    
    // Search for the file
    let files = await vscode.workspace.findFiles(`**/${searchPath}`);
    
    if (files.length === 0) {
      // Try just the filename
      const filename = searchPath.split("/").pop() || searchPath;
      files = await vscode.workspace.findFiles(`**/${filename}`);
    }
    
    if (files.length === 0) {
      return new vscode.MarkdownString(`*File not found: ${linkTarget}*`);
    }
    
    const filePath = files[0].fsPath;
    
    // Skip if linking to current file
    if (filePath === currentDocument.uri.fsPath) {
      return null;
    }
    
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      
      // Get first 20 lines for preview
      const previewLines = lines.slice(0, 20);
      let previewContent = previewLines.join("\n");
      
      if (lines.length > 20) {
        previewContent += "\n\n*... (truncated)*";
      }
      
      const md = new vscode.MarkdownString();
      md.appendMarkdown(`**${path.basename(filePath)}**\n\n---\n\n`);
      md.appendMarkdown(previewContent);
      md.isTrusted = true;
      
      return md;
    } catch (err) {
      return new vscode.MarkdownString(`*Error reading file: ${err}*`);
    }
  }
}
