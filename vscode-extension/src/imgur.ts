import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { ObsidianClient, ImgurConfigResponse } from "./client";

interface ImgurUploadResponse {
  data: {
    link: string;
    id: string;
  };
  success: boolean;
  status: number;
}

export class ImgurUploadHandler {
  private config: ImgurConfigResponse | null = null;
  private initialized = false;

  constructor(private client: ObsidianClient) {}

  async initialize(): Promise<boolean> {
    if (this.initialized) {
      return this.config?.available ?? false;
    }

    try {
      this.config = await this.client.getImgurConfig();
    } catch {
      this.config = null;
    }
    
    this.initialized = true;
    
    if (!this.config?.available) {
      console.log("[ImgurUploadHandler] Imgur plugin not available");
      return false;
    }

    if (!this.config.clientId) {
      console.log("[ImgurUploadHandler] No clientId configured");
      return false;
    }

    console.log(`[ImgurUploadHandler] Initialized: strategy=${this.config.uploadStrategy}, hasAccessToken=${!!this.config.accessToken}`);
    return true;
  }

  isAvailable(): boolean {
    return this.config?.available ?? false;
  }

  /**
   * Upload a local image file to Imgur and return the URL
   */
  async uploadLocalFile(filePath: string): Promise<string | null> {
    if (!this.config?.clientId) {
      return null;
    }

    // Resolve path
    let resolvedPath = filePath;
    if (!path.isAbsolute(filePath)) {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        resolvedPath = path.join(workspaceFolder.uri.fsPath, filePath);
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      console.log("[ImgurUploadHandler] File not found:", resolvedPath);
      return null;
    }

    const imageBuffer = fs.readFileSync(resolvedPath);
    const base64Image = imageBuffer.toString("base64");

    return this.uploadToImgur(base64Image);
  }

  /**
   * Upload base64 image data to Imgur
   */
  async uploadToImgur(base64Image: string): Promise<string | null> {
    if (!this.config?.clientId) {
      return null;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    // Use access token if available (authenticated upload), otherwise use client ID (anonymous)
    if (this.config.accessToken) {
      headers["Authorization"] = `Bearer ${this.config.accessToken}`;
    } else {
      headers["Authorization"] = `Client-ID ${this.config.clientId}`;
    }

    try {
      const response = await fetch("https://api.imgur.com/3/image", {
        method: "POST",
        headers,
        body: JSON.stringify({
          image: base64Image,
          type: "base64",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("[ImgurUploadHandler] Upload failed:", response.status, errorText);
        throw new Error(`Upload failed: ${response.status} ${errorText}`);
      }

      const result = (await response.json()) as ImgurUploadResponse;
      
      if (result.success && result.data?.link) {
        console.log("[ImgurUploadHandler] Upload successful:", result.data.link);
        return result.data.link;
      }

      throw new Error("Upload failed: no link in response");
    } catch (err) {
      console.error("[ImgurUploadHandler] Upload error:", err);
      throw err;
    }
  }

  /**
   * Upload image from buffer
   */
  async uploadImageBuffer(buffer: Buffer): Promise<string | null> {
    const base64Image = buffer.toString("base64");
    return this.uploadToImgur(base64Image);
  }

  /**
   * Pick an image file and upload it to Imgur
   */
  async pickAndUpload(): Promise<string | null> {
    if (!this.config?.clientId) {
      vscode.window.showErrorMessage("Imgur not configured. Make sure Obsidian Imgur plugin is installed.");
      return null;
    }

    const options: vscode.OpenDialogOptions = {
      canSelectMany: false,
      openLabel: "Upload to Imgur",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "webp"],
      },
    };

    const fileUri = await vscode.window.showOpenDialog(options);
    if (!fileUri || fileUri.length === 0) {
      return null;
    }

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Uploading to Imgur...",
        cancellable: false,
      },
      async () => {
        try {
          const imageBuffer = fs.readFileSync(fileUri[0].fsPath);
          const base64Image = imageBuffer.toString("base64");
          const url = await this.uploadToImgur(base64Image);
          
          if (url) {
            vscode.window.showInformationMessage(`Uploaded: ${url}`);
          }
          
          return url;
        } catch (err) {
          vscode.window.showErrorMessage(`Upload failed: ${err}`);
          return null;
        }
      }
    );
  }

  /**
   * Insert an Imgur image link at the current cursor position (file picker)
   */
  async insertImageLink(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage("No active editor");
      return;
    }

    const url = await this.pickAndUpload();
    if (url) {
      await editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, `![](${url})`);
      });
    }
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
        (err, stdout) => {
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
   * Paste image from clipboard: read clipboard → upload to Imgur → insert link.
   * Falls back to normal paste if no image in clipboard.
   */
  async pasteImageFromClipboard(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== "markdown") {
      // Not markdown, do normal paste
      await vscode.commands.executeCommand("editor.action.clipboardPasteAction");
      return;
    }

    // Ensure Imgur is available
    if (!this.isAvailable()) {
      const initialized = await this.initialize();
      if (!initialized) {
        vscode.window.showWarningMessage("Imgur not available. Make sure Obsidian is connected and Imgur plugin is installed.");
        return;
      }
    }

    // Try to read image from clipboard
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

    // Upload to Imgur
    const url = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Uploading to Imgur...",
        cancellable: false,
      },
      async () => this.uploadToImgur(base64)
    );

    if (url) {
      await editor.edit((editBuilder) => {
        editBuilder.insert(editor.selection.active, `![](${url})`);
      });
      vscode.window.showInformationMessage(`Uploaded: ${url}`);
    }
  }
}
