import * as vscode from "vscode";
import * as path from "path";

interface FileEntry {
  /** File path relative to workspace */
  relativePath: string;
  /** File name without extension */
  name: string;
  /** Aliases from frontmatter */
  aliases: string[];
  /** Full file path */
  fullPath: string;
}

export class WikilinkCompletionProvider implements vscode.CompletionItemProvider {
  private fileCache: FileEntry[] = [];
  private cacheValid = false;
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor() {
    this.setupWatcher();
  }

  private setupWatcher(): void {
    // Watch for file changes to invalidate cache
    this.watcher = vscode.workspace.createFileSystemWatcher("**/*.md");
    this.watcher.onDidCreate(() => this.invalidateCache());
    this.watcher.onDidDelete(() => this.invalidateCache());
    this.watcher.onDidChange((uri) => this.updateFileEntry(uri));
  }

  private invalidateCache(): void {
    this.cacheValid = false;
  }

  private async updateFileEntry(uri: vscode.Uri): Promise<void> {
    // Update single file entry when content changes
    const entry = await this.parseFile(uri);
    if (!entry) return;

    const index = this.fileCache.findIndex((e) => e.fullPath === uri.fsPath);
    if (index !== -1) {
      this.fileCache[index] = entry;
    }
  }

  private async buildCache(): Promise<void> {
    if (this.cacheValid) return;

    const files = await vscode.workspace.findFiles("**/*.md", "**/node_modules/**");
    const entries: FileEntry[] = [];

    for (const file of files) {
      const entry = await this.parseFile(file);
      if (entry) {
        entries.push(entry);
      }
    }

    this.fileCache = entries;
    this.cacheValid = true;
  }

  private async parseFile(uri: vscode.Uri): Promise<FileEntry | null> {
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const text = doc.getText();
      const relativePath = vscode.workspace.asRelativePath(uri);
      const name = path.basename(uri.fsPath, ".md");

      // Parse frontmatter for aliases
      const aliases = this.parseAliases(text);

      return {
        relativePath,
        name,
        aliases,
        fullPath: uri.fsPath,
      };
    } catch {
      return null;
    }
  }

  private parseAliases(text: string): string[] {
    const aliases: string[] = [];

    // Check for YAML frontmatter
    if (!text.startsWith("---")) return aliases;

    const endIndex = text.indexOf("\n---", 3);
    if (endIndex === -1) return aliases;

    const frontmatter = text.substring(3, endIndex);

    // Parse aliases field
    // Formats: 
    //   aliases: [a, b, c]
    //   aliases:
    //     - a
    //     - b
    const inlineMatch = frontmatter.match(/^aliases:\s*\[([^\]]*)\]/m);
    if (inlineMatch) {
      const items = inlineMatch[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
      aliases.push(...items.filter((s) => s.length > 0));
    } else {
      // Multi-line format
      const lines = frontmatter.split("\n");
      let inAliases = false;
      for (const line of lines) {
        if (line.match(/^aliases:\s*$/)) {
          inAliases = true;
          continue;
        }
        if (inAliases) {
          const itemMatch = line.match(/^\s+-\s*(.+)$/);
          if (itemMatch) {
            aliases.push(itemMatch[1].trim().replace(/^["']|["']$/g, ""));
          } else if (!line.match(/^\s/)) {
            // No longer in aliases block
            inAliases = false;
          }
        }
      }
    }

    return aliases;
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionList | null> {
    // Check if we're inside [[ ]]
    const lineText = document.lineAt(position).text;
    const textBefore = lineText.substring(0, position.character);

    // Find the last [[ before cursor
    const openIndex = textBefore.lastIndexOf("[[");
    if (openIndex === -1) return null;

    // Check there's no ]] between [[ and cursor
    const textAfterOpen = textBefore.substring(openIndex + 2);
    if (textAfterOpen.includes("]]")) return null;

    // Get the text typed so far after [[
    const query = textAfterOpen.toLowerCase();
    
    // Calculate range to replace (from after [[ to cursor)
    const replaceRange = new vscode.Range(
      new vscode.Position(position.line, openIndex + 2),
      position
    );

    // Build cache if needed
    await this.buildCache();

    const items: vscode.CompletionItem[] = [];
    const seen = new Set<string>();

    for (const entry of this.fileCache) {
      // Skip current file
      if (entry.fullPath === document.uri.fsPath) continue;

      // Match by filename or show all if query is empty
      const matchesQuery = query === "" || entry.name.toLowerCase().includes(query);
      
      // Add file name completion
      if (!seen.has(entry.name) && matchesQuery) {
        const item = new vscode.CompletionItem(entry.name, vscode.CompletionItemKind.File);
        item.detail = entry.relativePath;
        item.insertText = entry.name;
        item.filterText = entry.name;
        item.sortText = "0" + entry.name; // Prioritize exact file names
        item.range = replaceRange;
        items.push(item);
        seen.add(entry.name);
      }

      // Add alias completions
      for (const alias of entry.aliases) {
        const key = `${entry.name}|${alias}`;
        const aliasMatches = query === "" || alias.toLowerCase().includes(query);
        if (!seen.has(key) && aliasMatches) {
          const item = new vscode.CompletionItem(alias, vscode.CompletionItemKind.Reference);
          item.detail = `→ ${entry.name} (${entry.relativePath})`;
          item.insertText = alias;
          item.filterText = alias;
          item.sortText = "1" + alias; // Aliases after file names
          item.range = replaceRange;
          items.push(item);
          seen.add(key);
        }
      }
    }

    // Return as CompletionList to ensure popup shows immediately
    return new vscode.CompletionList(items, false);
  }

  dispose(): void {
    this.watcher?.dispose();
  }
}
