import { App } from "obsidian";
import type { Server, IncomingMessage } from "http";
import type { Duplex } from "stream";
import { createServer } from "http";
import { createHash } from "crypto";
import { renderMarkdown, resolveWikilink } from "./renderer";

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

export interface ErrorResponse {
  type: "error";
  message: string;
}

type RequestMessage = RenderRequest | ResolveRequest;
type ResponseMessage = RenderResponse | ResolveResponse | ErrorResponse;

/**
 * Simple WebSocket server using Node.js built-in http module.
 * This avoids compatibility issues with the 'ws' package in Electron.
 */
export class RenderServer {
  private server: Server | null = null;
  private clients: Set<Duplex> = new Set();
  private app: App;
  private port: number;

  constructor(app: App, port: number) {
    this.app = app;
    this.port = port;
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
          void this.handleMessage(message).then((response) => {
            this.sendFrame(socket, JSON.stringify(response));
          });
        }
      });

      socket.on("close", () => {
        this.clients.delete(socket);
      });

      socket.on("error", () => {
        this.clients.delete(socket);
      });
    });

    this.server.listen(this.port);
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

  private async handleMessage(data: string): Promise<ResponseMessage> {
    let request: RequestMessage;
    try {
      request = JSON.parse(data) as RequestMessage;
    } catch {
      return { type: "error", message: "Invalid JSON" };
    }

    if (request.type === "render") {
      const result = await renderMarkdown(
        this.app,
        request.filePath,
        request.content
      );
      return {
        type: "render",
        html: result.html,
        css: result.css,
      };
    }

    if (request.type === "resolve") {
      const result = resolveWikilink(
        this.app,
        request.link,
        request.currentFile
      );
      return {
        type: "resolve",
        displayText: result.displayText,
        targetPath: result.targetPath,
      };
    }

    return { type: "error", message: "Unknown request type" };
  }
}
