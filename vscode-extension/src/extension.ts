import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ObsidianClient } from "./client";
import { EditorWatcher } from "./watcher";
import { PreviewPanel } from "./preview";
import { EditorDecorator } from "./decorator";
import { WikilinkHoverProvider } from "./hover";
import { WikilinkLinkProvider } from "./linkProvider";
import { WikilinkCompletionProvider } from "./completionProvider";
import { ImgurUploadHandler } from "./imgur";
import { logger, Logger } from "./logger";

let client: ObsidianClient;
let watcher: EditorWatcher;
let decorator: EditorDecorator;
let hoverProvider: WikilinkHoverProvider;
let linkProvider: WikilinkLinkProvider;
let completionProvider: WikilinkCompletionProvider;
let imgurHandler: ImgurUploadHandler;
let hoverProviderDisposable: vscode.Disposable | undefined;
let linkProviderDisposable: vscode.Disposable | undefined;
let completionProviderDisposable: vscode.Disposable | undefined;
let previewPanel: PreviewPanel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("obsidianPreview");
  const port = config.get<number>("port") ?? 27123;

  client = new ObsidianClient(port);
  watcher = new EditorWatcher();
  decorator = new EditorDecorator();
  hoverProvider = new WikilinkHoverProvider();
  linkProvider = new WikilinkLinkProvider();
  completionProvider = new WikilinkCompletionProvider();
  imgurHandler = new ImgurUploadHandler(client);
  
  // Register hover provider for markdown files
  hoverProviderDisposable = vscode.languages.registerHoverProvider(
    { language: "markdown" },
    hoverProvider
  );
  context.subscriptions.push(hoverProviderDisposable);
  
  // Register link provider for Ctrl+Click navigation
  linkProviderDisposable = vscode.languages.registerDocumentLinkProvider(
    { language: "markdown" },
    linkProvider
  );
  context.subscriptions.push(linkProviderDisposable);

  // Register completion provider for [[wikilinks]]
  completionProviderDisposable = vscode.languages.registerCompletionItemProvider(
    { language: "markdown" },
    completionProvider,
    "[" // Trigger on [
  );
  context.subscriptions.push(completionProviderDisposable);

  // Handle render updates (pushed from server)
  client.onRenderUpdate((response) => {
    if (previewPanel && response.filePath) {
      const fileName = response.filePath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || '';
      previewPanel.updateContent(response.html, response.css, fileName);
      logger.debug(`Render update applied for: ${fileName}`);
    }
  });

  // Command: Connect to Obsidian
  const connectCommand = vscode.commands.registerCommand(
    "obsidian-preview.connect",
    async () => {
      try {
        await client.connect();
        vscode.window.showInformationMessage("Connected to Obsidian");
        // Enable editor decorations and hover provider when connected
        decorator.enable();
        hoverProvider.enable();
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to connect: ${err}`);
      }
    }
  );

  // Handle disconnection - disable decorations and hover
  client.onDisconnect(() => {
    decorator.disable();
    hoverProvider.disable();
  });

  // Command: Open preview panel
  const openCommand = vscode.commands.registerCommand(
    "obsidian-preview.open",
    async () => {
      await openPreviewPanel(context, false);
    }
  );

  // Command: Open debug preview panel
  const openDebugCommand = vscode.commands.registerCommand(
    "obsidian-preview.openDebug",
    async () => {
      await openPreviewPanel(context, true);
    }
  );

  // Command: Open log file
  const openLogCommand = vscode.commands.registerCommand(
    "obsidian-preview.openLog",
    async () => {
      const logPath = Logger.getLogFilePath();
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
        await vscode.window.showTextDocument(doc);
      } catch {
        vscode.window.showWarningMessage(`Log file not found: ${logPath}`);
      }
    }
  );

  // Command: Clear log file
  const clearLogCommand = vscode.commands.registerCommand(
    "obsidian-preview.clearLog",
    () => {
      Logger.clearLog();
      vscode.window.showInformationMessage("Log file cleared");
    }
  );

  // Command: Navigate to wikilink (used by DocumentLinkProvider)
  const navigateToLinkCommand = vscode.commands.registerCommand(
    "obsidian-preview.navigateToLink",
    async (args: { target: string; sourcePath: string }) => {
      await navigateToWikilink(args.target, args.sourcePath);
    }
  );

  // Command: Upload image to Imgur (file picker)
  const uploadImgurCommand = vscode.commands.registerCommand(
    "obsidian-preview.uploadToImgur",
    async () => {
      if (!client.isConnected()) {
        try {
          await client.connect();
        } catch (err) {
          vscode.window.showErrorMessage(`Not connected to Obsidian: ${err}`);
          return;
        }
      }
      
      await imgurHandler.initialize();
      if (!imgurHandler.isAvailable()) {
        vscode.window.showWarningMessage(
          "Imgur not available. Make sure Obsidian Imgur plugin is installed and configured."
        );
        return;
      }
      
      await imgurHandler.insertImageLink();
    }
  );

  // Command: Paste image from clipboard → Imgur (Ctrl+Shift+V)
  const pasteImgurCommand = vscode.commands.registerCommand(
    "obsidian-preview.pasteImageToImgur",
    async () => {
      if (!client.isConnected()) {
        try {
          await client.connect();
        } catch (err) {
          // Fall back to normal paste
          await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
          return;
        }
      }
      
      await imgurHandler.pasteImageFromClipboard();
    }
  );

  async function openPreviewPanel(ctx: vscode.ExtensionContext, debugMode: boolean) {
    // Create panel first so we can show error in it
    if (previewPanel) {
      previewPanel.dispose();
    }
    previewPanel = PreviewPanel.create(ctx.extensionUri, debugMode);
    
    // Handle panel dispose
    previewPanel.onDispose(() => {
      previewPanel = undefined;
    });

    // Handle link clicks
    previewPanel.onLinkClick(async (targetPath) => {
      await handleLinkClick(targetPath);
    });

    // Handle hover preview requests
    previewPanel.onHoverPreview(async (targetPath) => {
      return await getHoverPreview(targetPath);
    });

    // Handle refresh button click
    previewPanel.onRefresh(async () => {
      logger.info("Refresh requested - restarting server");
      try {
        await client.restart();
        // Re-render current file
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId === "markdown") {
          await updatePreview(editor.document);
        }
      } catch (err) {
        logger.error(`Refresh failed: ${err}`);
        vscode.window.showErrorMessage(`Refresh failed: ${err}`);
      }
    });

    if (!client.isConnected()) {
      try {
        await client.connect();
        // Enable editor decorations and hover when connected
        decorator.enable();
        hoverProvider.enable();
      } catch (err) {
        // Show error in the preview panel
        previewPanel.updateContent(
          `<div style="text-align:center;padding:40px;">
            <h2 style="color:#d32f2f;">Cannot Connect to Obsidian</h2>
            <p style="color:#666;margin:20px 0;">Please make sure:</p>
            <ul style="text-align:left;display:inline-block;color:#666;">
              <li>Obsidian is running</li>
              <li>The <strong>Obsidian Render Server</strong> plugin is enabled</li>
              <li>Port 27123 is not blocked</li>
            </ul>
            <p style="color:#999;margin-top:20px;font-size:12px;">Error: ${err}</p>
          </div>`,
          ""
        );
        return;
      }
    }

    // Initial render
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "markdown") {
      await updatePreview(editor.document);
    }
  }

  // Watch for content changes
  watcher.onContentChange(async (filePath, content) => {
    if (previewPanel && client.isConnected()) {
      const fileName = filePath.split(/[/\\]/).pop() || '';
      logger.debug(`Render request for: ${fileName}`);
      try {
        const result = await client.render(filePath, content);
        // Extract filename without extension for title
        const titleName = fileName.replace(/\.md$/i, '');
        previewPanel.updateContent(result.html, result.css, titleName);
        logger.debug(`Render complete for: ${fileName}`);
      } catch (err) {
        const errorMsg = String(err);
        const titleName = fileName.replace(/\.md$/i, '');
        logger.error(`Render failed for ${fileName}: ${errorMsg}`);
        previewPanel.updateContent(
          `<div style="color:red;padding:20px;">Render failed: ${err}</div>`,
          "",
          titleName
        );
      }
    }
  });
  watcher.start();

  // Watch for active editor changes
  const editorChangeDisposable = vscode.window.onDidChangeActiveTextEditor(
    async (editor) => {
      if (
        previewPanel &&
        editor &&
        editor.document.languageId === "markdown"
      ) {
        // Show loading immediately when switching files
        const fileName = editor.document.uri.fsPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || '';
        previewPanel.showLoading(fileName);
        await updatePreview(editor.document);
      }
    }
  );

  context.subscriptions.push(
    connectCommand,
    openCommand,
    openDebugCommand,
    openLogCommand,
    clearLogCommand,
    navigateToLinkCommand,
    uploadImgurCommand,
    pasteImgurCommand,
    editorChangeDisposable
  );

  logger.info("Extension activated");
}

async function updatePreview(document: vscode.TextDocument): Promise<void> {
  if (!previewPanel || !client.isConnected()) return;

  const filePath = document.uri.fsPath;
  const content = document.getText();
  // Extract filename without extension for title
  const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.md$/i, '') || '';
  
  try {
    const result = await client.render(filePath, content);
    previewPanel.updateContent(result.html, result.css, fileName);
  } catch (err) {
    console.error("[Preview] Render failed:", err);
    previewPanel.updateContent(
      `<div style="color:red;padding:20px;">Render failed: ${err}</div>`,
      "",
      fileName
    );
  }
}

async function getHoverPreview(targetPath: string): Promise<{ html: string; css: string } | null> {
  if (!client.isConnected()) return null;
  
  // Skip same-file anchors (e.g., "#Heading")
  if (targetPath.startsWith("#")) {
    return null;
  }
  
  try {
    // Parse the link - handle [[File#Heading]] format
    let filePart = targetPath;
    const hashIndex = targetPath.indexOf("#");
    if (hashIndex !== -1) {
      filePart = targetPath.substring(0, hashIndex);
    }
    
    // Add .md extension if not present
    let searchPath = filePart;
    if (!searchPath.endsWith(".md")) {
      searchPath = searchPath + ".md";
    }
    
    // Find the file
    let files = await vscode.workspace.findFiles(`**/${searchPath}`);
    if (files.length === 0) {
      const filename = searchPath.split("/").pop() || searchPath;
      files = await vscode.workspace.findFiles(`**/${filename}`);
    }
    
    if (files.length === 0) {
      return { html: `<p><em>File not found: ${targetPath}</em></p>`, css: "" };
    }
    
    // Read file content
    const doc = await vscode.workspace.openTextDocument(files[0]);
    const content = doc.getText();
    
    // Get first 50 lines for preview
    const lines = content.split("\n").slice(0, 50);
    const previewContent = lines.join("\n");
    
    // Render through Obsidian
    const result = await client.render(files[0].fsPath, previewContent);
    return result;
  } catch (err) {
    console.error("[Preview] Hover preview failed:", err);
    return null;
  }
}

/**
 * Navigate to a wikilink target, with option to create file if not found.
 * @param targetPath The link target (e.g., "File", "File#Heading", "Folder/File")
 * @param sourcePath The path of the source file containing the link
 */
async function navigateToWikilink(targetPath: string, sourcePath?: string): Promise<void> {
  if (!targetPath) return;

  console.log("[Navigate] target:", targetPath, "source:", sourcePath);

  // Parse the link - handle [[File#Heading]] format
  let filePart = targetPath;
  let anchorPart = "";
  
  const hashIndex = targetPath.indexOf("#");
  if (hashIndex !== -1) {
    filePart = targetPath.substring(0, hashIndex);
    anchorPart = targetPath.substring(hashIndex + 1);
  }
  
  // If only anchor (e.g., "#Code"), it's a link within the same file
  if (!filePart && anchorPart) {
    await navigateToAnchor(anchorPart);
    return;
  }
  
  // Add .md extension if not present
  let searchPath = filePart;
  if (!searchPath.endsWith(".md")) {
    searchPath = searchPath + ".md";
  }

  // Try to find the file
  let files = await vscode.workspace.findFiles(`**/${searchPath}`);
  
  // If not found, try without path (just filename)
  if (files.length === 0) {
    const filename = searchPath.split("/").pop() || searchPath;
    files = await vscode.workspace.findFiles(`**/${filename}`);
  }

  if (files.length > 0) {
    // File found - open it
    const doc = await vscode.workspace.openTextDocument(files[0]);
    const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    
    // If there's an anchor, navigate to it
    if (anchorPart) {
      await navigateToAnchorInEditor(editor, anchorPart);
    }
  } else {
    // File not found - ask to create
    await promptCreateFile(searchPath, sourcePath);
  }
}

/**
 * Navigate to an anchor in the current editor.
 */
async function navigateToAnchor(anchor: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  
  await navigateToAnchorInEditor(editor, anchor);
}

/**
 * Navigate to an anchor (heading) in the given editor.
 */
async function navigateToAnchorInEditor(editor: vscode.TextEditor, anchor: string): Promise<void> {
  const doc = editor.document;
  const text = doc.getText();
  const lines = text.split("\n");
  
  const anchorLower = anchor.toLowerCase().replace(/-/g, " ");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#+\s+(.+)$/);
    if (headingMatch) {
      const headingText = headingMatch[1].toLowerCase().trim();
      if (headingText === anchorLower || headingText.replace(/\s+/g, "-") === anchor.toLowerCase()) {
        const position = new vscode.Position(i, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
        break;
      }
    }
  }
}

/**
 * Prompt user to create a new file when link target doesn't exist.
 */
async function promptCreateFile(fileName: string, sourcePath?: string): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    `File "${fileName}" does not exist. Create it?`,
    "Yes",
    "No"
  );
  
  if (choice !== "Yes") return;
  
  // Determine target directory (same as source file, or workspace root)
  let targetDir: string;
  if (sourcePath) {
    targetDir = path.dirname(sourcePath);
  } else {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder open");
      return;
    }
    targetDir = workspaceFolder.uri.fsPath;
  }
  
  const newFilePath = path.join(targetDir, fileName);
  
  // Create the file with a basic template
  const fileNameWithoutExt = fileName.replace(/\.md$/, "");
  const content = `# ${fileNameWithoutExt}\n\n`;
  
  try {
    fs.writeFileSync(newFilePath, content, "utf8");
    const doc = await vscode.workspace.openTextDocument(newFilePath);
    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    vscode.window.showInformationMessage(`Created: ${fileName}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Failed to create file: ${err}`);
  }
}

async function handleLinkClick(targetPath: string): Promise<void> {
  // Use shared navigation logic, but without source path (preview doesn't have it)
  await navigateToWikilink(targetPath, vscode.window.activeTextEditor?.document.uri.fsPath);
}

export function deactivate(): void {
  client?.disconnect();
  watcher?.stop();
  decorator?.dispose();
  completionProvider?.dispose();
  previewPanel?.dispose();
}
