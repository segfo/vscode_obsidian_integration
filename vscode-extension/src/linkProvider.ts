import * as vscode from "vscode";

/**
 * Provides clickable links for [[wikilinks]] in markdown files.
 * Ctrl+Click to navigate to the linked file.
 */
export class WikilinkLinkProvider implements vscode.DocumentLinkProvider {
  
  provideDocumentLinks(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.DocumentLink[]> {
    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    
    // Match [[...]] wikilinks
    const wikilinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;
    
    while ((match = wikilinkRegex.exec(text)) !== null) {
      const linkText = match[1];
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);
      
      // Parse [[File|Alias]] or [[File#Heading|Alias]] format
      let target = linkText;
      const pipeIndex = linkText.indexOf("|");
      if (pipeIndex !== -1) {
        target = linkText.substring(0, pipeIndex);
      }
      
      // Create a command URI that will handle the navigation
      const commandUri = vscode.Uri.parse(
        `command:obsidian-preview.navigateToLink?${encodeURIComponent(JSON.stringify({ target, sourcePath: document.uri.fsPath }))}`
      );
      
      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Ctrl+Click to open: ${target}`;
      links.push(link);
    }
    
    return links;
  }
}
