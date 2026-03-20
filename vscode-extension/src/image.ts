import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";

export class ImagePasteAction {
  /**
   * Save base64 image data to _resources directory next to the markdown file.
   * Returns relative path from the markdown file directory to the saved image.
   */
  private async saveImageToResources(base64Image: string, markdownFilePath: string): Promise<string | null> {
    const markdownDir = path.dirname(markdownFilePath);
    const resourcesDir = path.join(markdownDir, "_resources");

    if (!fs.existsSync(resourcesDir)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const fileName = `image-${timestamp}.png`;
    const filePath = path.join(resourcesDir, fileName);

    const buffer = Buffer.from(base64Image, "base64");
    fs.writeFileSync(filePath, buffer);

    console.log(`[ImagePasteAction] Saved image: ${filePath}`);
    return `./_resources/${fileName}`;
  }

  /**
   * Read image from OS clipboard via PowerShell (Windows only).
   * Returns base64 PNG string, or null if no image in clipboard.
   */
  private readClipboardImage(): Promise<string | null> {
    return new Promise((resolve) => {
      if (process.platform !== "win32") {
        resolve(null);
        return;
      }

      const script = `
Add-Type -AssemblyName System.Windows.Forms
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) { exit 1 }
$ms = New-Object System.IO.MemoryStream
$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Console]::Write([Convert]::ToBase64String($ms.ToArray()))
$ms.Dispose()
$img.Dispose()
`;

      execFile("powershell", ["-NoProfile", "-NonInteractive", "-Command", script],
        { maxBuffer: 50 * 1024 * 1024 }, // 50MB for large images
        (err: Error | null, stdout: string) => {
          if (err || !stdout) {
            resolve(null);
            return;
          }
          resolve(stdout.trim());
        }
      );
    });
  }

  /**
   * Paste image from clipboard: read clipboard → save to _resources → insert link.
   * Falls back to normal paste if no image in clipboard.
   */
  async pasteImageFromClipboard(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "markdown") {
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      return;
    }

    const markdownFilePath = editor.document.uri.fsPath;
    if (!markdownFilePath || editor.document.isUntitled) {
      vscode.window.showWarningMessage("Please save the file before pasting images.");
      return;
    }

    const base64 = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Checking clipboard...",
        cancellable: false,
      },
      async () => this.readClipboardImage()
    );

    if (!base64) {
      // No image in clipboard, do normal paste
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      return;
    }

    const relativePath = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Saving image...",
        cancellable: false,
      },
      async () => this.saveImageToResources(base64, markdownFilePath)
    );

    if (relativePath) {
      await editor.edit((editBuilder: vscode.TextEditorEdit) => {
        editBuilder.insert(editor.selection.active, `![](${relativePath})`);
      });
      vscode.window.showInformationMessage(`Saved: ${relativePath}`);
    }
  }

  /**
   * Pick an image file, copy it to _resources, and insert link at cursor.
   */
  async insertImageLink(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor");
      return;
    }

    const markdownFilePath = editor.document.uri.fsPath;
    if (editor.document.isUntitled) {
      vscode.window.showWarningMessage("Please save the file before inserting images.");
      return;
    }

    const fileUri = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Insert Image",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    if (!fileUri || fileUri.length === 0) {
      return;
    }

    const markdownDir = path.dirname(markdownFilePath);
    const resourcesDir = path.join(markdownDir, "_resources");

    if (!fs.existsSync(resourcesDir)) {
      fs.mkdirSync(resourcesDir, { recursive: true });
    }

    const sourceFile = fileUri[0].fsPath;
    const fileName = path.basename(sourceFile);
    const destFile = path.join(resourcesDir, fileName);

    fs.copyFileSync(sourceFile, destFile);
    console.log(`[ImagePasteAction] Copied image: ${destFile}`);

    const relativePath = `./_resources/${fileName}`;
    await editor.edit((editBuilder: vscode.TextEditorEdit) => {
      editBuilder.insert(editor.selection.active, `![](${relativePath})`);
    });
    vscode.window.showInformationMessage(`Inserted: ${relativePath}`);
  }
}
