import { App } from "obsidian";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { createServer } from "http";
import { createHash } from "crypto";
import { renderMarkdown, resolveWikilink } from "./renderer";
import { logger } from "./logger";

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

export interface RenderResponse {
  type: "render";
  html: string;
  css: string;
}

export interface ResolveResponse {
  type: "resolve";
  displayText: string;
  targetPath: string;
}

export interface SettingsResponse {
  type: "settings";
  renderTimeout: number;
  renderGracePeriod: number;
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

type RequestMessage = RenderRequest | ResolveRequest | SettingsRequest;
type ResponseMessage = RenderResponse | ResolveResponse | ErrorResponse;

export interface RenderServerSettings {
  port: number;
  renderTimeout: number;
  renderGracePeriod: number;
}

interface PendingRender {
  request: RenderRequest;
  socket: Duplex;
  startTime: number;
}

/**
 * Simple WebSocket server using Node.js built-in http module.
 * This avoids compatibility issues with the 'ws' package in Electron.
 */
export class RenderServer {
  private server: Server | null = null;
  private clients: Set<Duplex> = new Set();
  private app: App;
  private settings: RenderServerSettings;
  
  // Render queue state
  private currentRender: PendingRender | null = null;
  private pendingRender: { request: RenderRequest; socket: Duplex } | null = null;
  private isProcessing = false;

  constructor(app: App, settings: RenderServerSettings) {
    this.app = app;
    this.settings = settings;
  }

  async start(): Promise<void> {
    this.server = createServer();

    this.server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
      const key = req.headers["sec-websocket-key"];
      if (!key) {
        socket.destroy();
        return;
      }

      // WebSocket handshake
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
      });

      socket.on("error", () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(this.settings.port);
  }

  stop(): void {
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
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
      // For simplicity, we don't handle very large payloads
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
      header[0] = 0x81; // FIN + text frame
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
        renderGracePeriod: this.settings.renderGracePeriod,
      }));
      return;
    }

    logger.warn(`Unknown request type: ${data}`);
    this.sendFrame(socket, JSON.stringify({ type: "error", message: "Unknown request type" }));
  }

  /**
   * Handle render request with queue logic:
   * - If no render is in progress, start immediately
   * - If a render is in progress:
   *   - Queue this request (replacing any existing queued request)
   *   - If current render exceeds grace period, cancel and start new
   */
  private async handleRenderRequest(request: RenderRequest, socket: Duplex): Promise<void> {
    const fileName = request.filePath.split(/[/\\]/).pop() || request.filePath;
    
    if (this.isProcessing) {
      // Check if current render has exceeded grace period
      if (this.currentRender) {
        const elapsed = Date.now() - this.currentRender.startTime;
        const gracePeriodMs = this.settings.renderGracePeriod * 1000;
        
        if (elapsed > gracePeriodMs) {
          // Current render exceeded grace period, queue new request and it will be picked up
          logger.info(`[QUEUE] ${fileName} (current render exceeded ${this.settings.renderGracePeriod}s grace period)`);
        } else {
          logger.debug(`[QUEUE] ${fileName} (waiting for current render, ${Math.round(elapsed/1000)}s elapsed)`);
        }
      }
      
      // Always queue the latest request (replaces any existing queued request)
      this.pendingRender = { request, socket };
      return;
    }

    await this.executeRender(request, socket);
  }

  private async executeRender(request: RenderRequest, socket: Duplex): Promise<void> {
    const fileName = request.filePath.split(/[/\\]/).pop() || request.filePath;
    const contentSize = request.content.length;
    const startTime = Date.now();
    
    this.isProcessing = true;
    this.currentRender = { request, socket, startTime };
    
    logger.info(`[START] ${fileName} (${contentSize} chars)`);
    
    try {
      const result = await renderMarkdown(
        this.app,
        request.filePath,
        request.content
      );
      const elapsed = Date.now() - startTime;
      logger.info(`[DONE] ${fileName} in ${elapsed}ms (${result.html.length} bytes)`);
      
      this.sendFrame(socket, JSON.stringify({
        type: "render",
        html: result.html,
        css: result.css,
      }));
    } catch (err) {
      const elapsed = Date.now() - startTime;
      const errorMsg = String(err);
      const stack = err instanceof Error ? err.stack : "";
      logger.error(`[FAIL] ${fileName} after ${elapsed}ms: ${errorMsg}`);
      if (stack) {
        logger.error(`Stack: ${stack}`);
      }
      this.sendFrame(socket, JSON.stringify({ type: "error", message: errorMsg }));
    } finally {
      this.isProcessing = false;
      this.currentRender = null;
      
      // Process queued request if any
      if (this.pendingRender) {
        const pending = this.pendingRender;
        this.pendingRender = null;
        const pendingFileName = pending.request.filePath.split(/[/\\]/).pop() || pending.request.filePath;
        logger.debug(`[DEQUEUE] Processing queued request: ${pendingFileName}`);
        await this.executeRender(pending.request, pending.socket);
      }
    }
  }
}
