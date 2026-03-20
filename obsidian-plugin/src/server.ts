import { App } from "obsidian";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { createServer } from "http";
import { createHash } from "crypto";
import { renderMarkdownImmediate, resolveWikilink, extractThemeCSS } from "./renderer";
import { logger } from "./logger";

// Electron window control for preventing background throttling
interface ElectronWindow {
  isMinimized: () => boolean;
  restore: () => void;
  setSize: (width: number, height: number) => void;
  setPosition: (x: number, y: number) => void;
  isVisible: () => boolean;
  show: () => void;
  focus: () => void;
  webContents: { setBackgroundThrottling: (enabled: boolean) => void };
}

let electronWindow: ElectronWindow | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef
  const electron = require("electron") as { remote?: { getCurrentWindow?: () => ElectronWindow } };
  electronWindow = electron.remote?.getCurrentWindow?.() ?? null;
  if (electronWindow) {
    electronWindow.webContents.setBackgroundThrottling(false);
    logger.debug("[WINDOW] Background throttling disabled");
  }
} catch {
  // Electron API not available
  electronWindow = null;
}

export interface RenderRequest {
  type: "render";
  filePath: string;
  content: string;
}

export interface ResolveRequest {
  type: "resolve";
  link: string;
  currentFile: string;
}

export interface SettingsRequest {
  type: "getSettings";
}

export interface RestartRequest {
  type: "restart";
}

export interface ImgurConfigRequest {
  type: "getImgurConfig";
}

export interface FocusWindowRequest {
  type: "focusWindow";
}

export interface RenderResponse {
  type: "render";
  html: string;
  css: string;
  filePath: string;
  isUpdate?: boolean;
}

export interface ResolveResponse {
  type: "resolve";
  displayText: string;
  targetPath: string;
}

export interface SettingsResponse {
  type: "settings";
  renderTimeout: number;
  typingDelay: number;
  updateDelay: number;
  monitorTime: number;
  protocolVersion: number;
}

export interface ImgurConfigResponse {
  type: "imgurConfig";
  available: boolean;
  clientId?: string;
  accessToken?: string;
  uploadStrategy?: string;
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

type RequestMessage = RenderRequest | ResolveRequest | SettingsRequest | RestartRequest | ImgurConfigRequest | FocusWindowRequest;

export interface RenderServerSettings {
  port: number;
  renderTimeout: number;
  typingDelay: number;
  updateDelay: number;
  monitorTime: number;
}

export type RestartCallback = () => void;

/**
 * Simple WebSocket server using Node.js built-in http module.
 * Supports streaming updates for render results.
 */
export class RenderServer {
  private server: Server | null = null;
  private clients: Set<Duplex> = new Set();
  private app: App;
  private settings: RenderServerSettings;
  private onRestartRequest: RestartCallback | null = null;
  
  // Current render state
  private currentFilePath: string | null = null;
  private currentSocket: Duplex | null = null;
  private currentMonitor: { 
    observer: MutationObserver; 
    timer: ReturnType<typeof setTimeout>; 
    debounceTimer: ReturnType<typeof setTimeout> | null;
    container: HTMLElement;
    sessionId: number;
  } | null = null;
  private pendingRender: { request: RenderRequest; socket: Duplex } | null = null;
  private isProcessing = false;
  private lastSentHtml: string = "";
  private monitorSessionId = 0;

  constructor(app: App, settings: RenderServerSettings, onRestartRequest?: RestartCallback) {
    this.app = app;
    this.settings = settings;
    this.onRestartRequest = onRestartRequest ?? null;
  }

  async start(): Promise<void> {
    this.server = createServer();

    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      const acceptKey = createHash("sha1")
        .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

      const responseHeaders = [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${acceptKey}`,
        "",
        "",
      ].join("\r\n");

      socket.write(responseHeaders);
      this.clients.add(socket);

      socket.on("data", (buffer: Buffer) => {
        const message = this.decodeFrame(buffer);
        if (message) {
          void this.handleMessage(message, socket);
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
        if (this.currentSocket === socket) {
          this.stopMonitoring();
        }
      });

      socket.on("error", () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(this.settings.port);
  }

  stop(): void {
    this.stopMonitoring();
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }

  /**
   * Ensure window is visible to prevent Electron background throttling.
   * Only acts if window is minimized - restores to small window in top-left corner.
   */
  private ensureWindowVisible(): void {
    if (!electronWindow) return;
    
    try {
      if (electronWindow.isMinimized()) {
        logger.debug("[WINDOW] Restoring minimized window to prevent throttling");
        electronWindow.restore();
      }
      // Always ensure window is small and in top-left corner
      // electronWindow.setSize(200, 200);
      // electronWindow.setPosition(0, 0);
    } catch (err) {
      // Ignore errors - window control is optional
      logger.debug(`[WINDOW] Failed to control window: ${err}`);
    }
  }

  private stopMonitoring(): void {
    if (this.currentMonitor) {
      this.currentMonitor.observer.disconnect();
      clearTimeout(this.currentMonitor.timer);
      if (this.currentMonitor.debounceTimer) {
        clearTimeout(this.currentMonitor.debounceTimer);
      }
      document.body.removeChild(this.currentMonitor.container);
      this.currentMonitor = null;
    }
    this.currentFilePath = null;
    this.currentSocket = null;
    this.lastSentHtml = "";
  }

  private decodeFrame(buffer: Buffer): string | null {
    if (buffer.length < 2) return null;

    const secondByte = buffer[1];
    const isMasked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      payloadLength = buffer.readUInt16BE(2);
      offset = 4;
    } else if (payloadLength === 127) {
      payloadLength = buffer.readUInt32BE(6);
      offset = 10;
    }

    let maskKey: Buffer | null = null;
    if (isMasked) {
      maskKey = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    const payload = buffer.subarray(offset, offset + payloadLength);

    if (maskKey) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= maskKey[i % 4];
      }
    }

    return payload.toString("utf8");
  }

  private sendFrame(socket: Duplex, message: string): void {
    const payload = Buffer.from(message, "utf8");
    const payloadLength = payload.length;

    let header: Buffer;
    if (payloadLength < 126) {
      header = Buffer.alloc(2);
      header[0] = 0x81;
      header[1] = payloadLength;
    } else if (payloadLength < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(payloadLength, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payloadLength), 2);
    }

    socket.write(Buffer.concat([header, payload]));
  }

  private async handleMessage(data: string, socket: Duplex): Promise<void> {
    let request: RequestMessage;
    try {
      request = JSON.parse(data) as RequestMessage;
    } catch {
      logger.error("Invalid JSON received");
      this.sendFrame(socket, JSON.stringify({ type: "error", message: "Invalid JSON" }));
      return;
    }

    if (request.type === "render") {
      await this.handleRenderRequest(request, socket);
      return;
    }

    if (request.type === "resolve") {
      const result = resolveWikilink(
        this.app,
        request.link,
        request.currentFile
      );
      this.sendFrame(socket, JSON.stringify({
        type: "resolve",
        displayText: result.displayText,
        targetPath: result.targetPath,
      }));
      return;
    }

    if (request.type === "getSettings") {
      logger.debug("Settings request received");
      this.sendFrame(socket, JSON.stringify({
        type: "settings",
        renderTimeout: this.settings.renderTimeout,
        typingDelay: this.settings.typingDelay,
        updateDelay: this.settings.updateDelay,
        monitorTime: this.settings.monitorTime,
        protocolVersion: 2,
      }));
      return;
    }

    if (request.type === "focusWindow") {
      logger.debug("Focus window request received");
      if (electronWindow) {
        try {
          electronWindow.show();
          electronWindow.focus();
        } catch (err) {
          logger.debug(`[WINDOW] Focus failed: ${err}`);
        }
      }
      this.sendFrame(socket, JSON.stringify({ type: "focusWindow", success: true }));
      return;
    }

    if (request.type === "restart") {
      logger.info("Restart request received - reloading plugin");
      if (this.onRestartRequest) {
        // Call the restart callback (will reload entire plugin)
        this.onRestartRequest();
      } else {
        // Fallback: just stop and restart server
        this.stop();
        void this.start();
      }
      // Note: client will need to reconnect
      return;
    }

    if (request.type === "getImgurConfig") {
      logger.debug("Imgur config request received");
      const config = await this.getImgurConfig();
      this.sendFrame(socket, JSON.stringify(config));
      return;
    }

    logger.warn(`Unknown request type: ${data}`);
    this.sendFrame(socket, JSON.stringify({ type: "error", message: "Unknown request type" }));
  }

  private async handleRenderRequest(request: RenderRequest, socket: Duplex): Promise<void> {
    const fileName = request.filePath.split(/[/\\]/).pop() || request.filePath;
    const isDifferentFile = this.currentFilePath !== request.filePath;
    
    // If switching files, stop current monitoring
    if (isDifferentFile && this.currentMonitor) {
      logger.debug(`[SWITCH] ${fileName} (stopping previous monitor)`);
      this.stopMonitoring();
    }
    
    if (this.isProcessing) {
      // Queue this request (replaces any existing queued request)
      logger.debug(`[QUEUE] ${fileName}`);
      this.pendingRender = { request, socket };
      return;
    }

    await this.executeRender(request, socket);
  }

  private async executeRender(request: RenderRequest, socket: Duplex): Promise<void> {
    const fileName = request.filePath.split(/[/\\]/).pop() || request.filePath;
    const contentSize = request.content.length;
    const startTime = Date.now();
    
    // Prevent background throttling: if window is minimized, restore to small window
    this.ensureWindowVisible();
    
    this.isProcessing = true;
    this.currentFilePath = request.filePath;
    this.currentSocket = socket;
    
    logger.info(`[START] ${fileName} (${contentSize} chars)`);
    
    try {
      // Render immediately (no plugin waiting)
      const { container, html } = await renderMarkdownImmediate(
        this.app,
        request.filePath,
        request.content
      );
      
      const elapsed = Date.now() - startTime;
      const css = extractThemeCSS();
      
      logger.info(`[DONE] ${fileName} in ${elapsed}ms (${html.length} bytes)`);
      
      // Send initial result
      this.lastSentHtml = html;
      this.sendFrame(socket, JSON.stringify({
        type: "render",
        html,
        css,
        filePath: request.filePath,
        isUpdate: false,
      }));
      
      // Start monitoring for DOM changes
      this.startMonitoring(container, request.filePath, socket, css);
      
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const errorMsg = String(err);
      logger.error(`[FAIL] ${fileName} after ${elapsed}ms: ${errorMsg}`);
      this.sendFrame(socket, JSON.stringify({ type: "error", message: errorMsg }));
      this.stopMonitoring();
    } finally {
      this.isProcessing = false;
      
      // Process queued request if any
      if (this.pendingRender) {
        const pending = this.pendingRender;
        this.pendingRender = null;
        
        // If same file, stop monitoring before re-rendering
        if (pending.request.filePath === this.currentFilePath) {
          this.stopMonitoring();
        }
        
        const pendingFileName = pending.request.filePath.split(/[/\\]/).pop() || pending.request.filePath;
        logger.debug(`[DEQUEUE] ${pendingFileName}`);
        await this.executeRender(pending.request, pending.socket);
      }
    }
  }

  private startMonitoring(container: HTMLElement, filePath: string, socket: Duplex, css: string): void {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    const updateDelayMs = this.settings.updateDelay * 1000;
    const monitorTimeMs = this.settings.monitorTime * 1000;
    
    // Create unique session ID for this monitoring session
    const sessionId = ++this.monitorSessionId;
    
    const sendUpdate = () => {
      // Check if this session is still active
      if (!this.currentMonitor || this.currentMonitor.sessionId !== sessionId) {
        return;
      }
      
      const newHtml = container.innerHTML;
      if (newHtml !== this.lastSentHtml) {
        logger.debug(`[UPDATE] ${fileName} (${newHtml.length} bytes)`);
        this.lastSentHtml = newHtml;
        this.sendFrame(socket, JSON.stringify({
          type: "render",
          html: newHtml,
          css,
          filePath,
          isUpdate: true,
        }));
      }
    };
    
    const observer = new MutationObserver(() => {
      // Check if this session is still active
      if (!this.currentMonitor || this.currentMonitor.sessionId !== sessionId) {
        return;
      }
      
      if (this.currentMonitor.debounceTimer) {
        clearTimeout(this.currentMonitor.debounceTimer);
      }
      this.currentMonitor.debounceTimer = setTimeout(sendUpdate, updateDelayMs);
    });
    
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    
    // Stop monitoring after monitorTime
    const timer = setTimeout(() => {
      // Check if this session is still active
      if (!this.currentMonitor || this.currentMonitor.sessionId !== sessionId) {
        return;
      }
      
      logger.debug(`[MONITOR END] ${fileName}`);
      // Send final update before stopping
      sendUpdate();
      // Cleanup
      observer.disconnect();
      if (this.currentMonitor.debounceTimer) {
        clearTimeout(this.currentMonitor.debounceTimer);
      }
      document.body.removeChild(container);
      this.currentMonitor = null;
    }, monitorTimeMs);
    
    this.currentMonitor = { observer, timer, debounceTimer: null, container, sessionId };
    logger.debug(`[MONITOR START] ${fileName} #${sessionId} (${this.settings.monitorTime}s)`);
  }

  private async getImgurConfig(): Promise<ImgurConfigResponse> {
    const pluginId = "obsidian-imgur-plugin";
    
    try {
      // Check if the imgur plugin is installed
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const plugins = (this.app as any).plugins as { plugins: Record<string, unknown> } | undefined;
      const imgurPlugin = plugins?.plugins?.[pluginId];
      
      if (!imgurPlugin) {
        logger.debug("Imgur plugin not found");
        return { type: "imgurConfig", available: false };
      }

      // Read plugin data.json
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      const vaultPath = (this.app.vault.adapter as any).basePath as string;
      const dataPath = `${vaultPath}/.obsidian/plugins/${pluginId}/data.json`;
      
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, no-undef
      const fs = require("fs") as typeof import("fs");
      
      let clientId: string | undefined;
      let uploadStrategy: string | undefined;
      
      if (fs.existsSync(dataPath)) {
        const dataContent = fs.readFileSync(dataPath, "utf-8");
        const data = JSON.parse(dataContent) as { clientId?: string; uploadStrategy?: string };
        clientId = data.clientId;
        uploadStrategy = data.uploadStrategy;
      }

      // Try to get access token from localStorage
      let accessToken: string | undefined;
      try {
        /* eslint-disable no-restricted-globals, no-undef */
        const tokenKey = `imgur-access-token`;
        accessToken = localStorage.getItem(tokenKey) ?? undefined;
        
        // Also try alternative key patterns
        if (!accessToken) {
          accessToken = localStorage.getItem(`${pluginId}-access-token`) ?? undefined;
        }
        if (!accessToken) {
          // Scan localStorage for any imgur-related token
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.toLowerCase().includes("imgur") && key.toLowerCase().includes("token")) {
              accessToken = localStorage.getItem(key) ?? undefined;
              if (accessToken) {
                logger.debug(`Found access token under key: ${key}`);
                break;
              }
            }
          }
        }
        /* eslint-enable no-restricted-globals, no-undef */
      } catch {
        logger.debug("Could not access localStorage for access token");
      }

      logger.info(`Imgur config: strategy=${uploadStrategy ?? "unknown"}, hasClientId=${!!clientId}, hasAccessToken=${!!accessToken}`);
      
      return {
        type: "imgurConfig",
        available: true,
        clientId,
        accessToken,
        uploadStrategy,
      };
    } catch (e) {
      logger.error(`Failed to get imgur config: ${e instanceof Error ? e.message : String(e)}`);
      return { type: "imgurConfig", available: false };
    }
  }
}
