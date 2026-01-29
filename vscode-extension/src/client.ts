import WebSocket from "ws";
import { Logger } from "./logger";

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

type ResponseMessage = RenderResponse | ResolveResponse | SettingsResponse | ErrorResponse;

export class ObsidianClient {
  private ws: WebSocket | null = null;
  private port: number;
  private pendingRequests: Map<
    number,
    { resolve: (value: ResponseMessage) => void; reject: (err: Error) => void }
  > = new Map();
  private requestId = 0;
  private disconnectCallbacks: Array<() => void> = [];
  private renderTimeoutMs = 60000; // Default 60s, updated from OBS settings

  constructor(port: number) {
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);

      this.ws.on("open", () => {
        // Fetch settings from OBS after connection
        void this.fetchSettings();
        resolve();
      });

      this.ws.on("error", (err) => {
        reject(err);
      });

      this.ws.on("close", () => {
        this.ws = null;
        this.disconnectCallbacks.forEach((cb) => cb());
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const response: ResponseMessage = JSON.parse(data.toString());
          console.log(`[ObsidianClient] Received response type=${response.type}, pending=${this.pendingRequests.size}`);
          
          // Simple response handling (no request ID in current protocol)
          const pendingEntry = this.pendingRequests.entries().next().value;
          if (pendingEntry) {
            const [id, pending] = pendingEntry;
            console.log(`[ObsidianClient] Resolving request #${id}`);
            pending.resolve(response);
            this.pendingRequests.delete(id);
          } else {
            console.warn(`[ObsidianClient] Received response but no pending request`);
          }
        } catch (err) {
          console.error(`[ObsidianClient] Failed to parse message:`, err);
        }
      });
    });
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async render(filePath: string, content: string): Promise<RenderResponse> {
    const response = await this.sendRequest({
      type: "render",
      filePath,
      content,
    });

    if (response.type === "error") {
      throw new Error(response.message);
    }

    return response as RenderResponse;
  }

  async resolveLink(
    link: string,
    currentFile: string
  ): Promise<ResolveResponse> {
    const response = await this.sendRequest({
      type: "resolve",
      link,
      currentFile,
    });

    if (response.type === "error") {
      throw new Error(response.message);
    }

    return response as ResolveResponse;
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback);
  }

  private async fetchSettings(): Promise<void> {
    try {
      const response = await this.sendRequest({ type: "getSettings" }, 5000);
      if (response.type === "settings") {
        this.renderTimeoutMs = response.renderTimeout * 1000;
        console.log(`[ObsidianClient] Settings received: renderTimeout=${response.renderTimeout}s`);
      }
    } catch (err) {
      console.warn("[ObsidianClient] Failed to fetch settings, using defaults:", err);
    }
  }

  private sendRequest(request: object, timeoutMs?: number): Promise<ResponseMessage> {
    const requestType = (request as { type?: string }).type || "unknown";
    // Use renderTimeoutMs for render requests, or provided timeout, or default 60s
    const effectiveTimeout = timeoutMs ?? (requestType === "render" ? this.renderTimeoutMs : 60000);
    
    return new Promise((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("WebSocket is null - not connected"));
        return;
      }
      
      if (this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`WebSocket not open (state: ${this.ws.readyState})`));
        return;
      }

      const id = ++this.requestId;
      const filePath = (request as { filePath?: string }).filePath || "";
      const fileName = filePath.split(/[/\\]/).pop() || filePath;
      const pendingCount = this.pendingRequests.size;
      const startTime = Date.now();
      const logPath = Logger.getLogFilePath();
      
      console.log(`[ObsidianClient] Sending request #${id} type=${requestType}, file=${fileName}, pending=${pendingCount}`);
      
      // Timeout handling with detailed error
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        const elapsed = Date.now() - startTime;
        const errorDetails = [
          `Timeout after ${elapsed}ms`,
          `Request: #${id} ${requestType}`,
          `File: ${fileName}`,
          `Pending: ${this.pendingRequests.size} other requests`,
          `Log: ${logPath}`,
          `Hint: Run "Obsidian Preview: Open Log File" to see details`,
        ].join("\n  ");
        reject(new Error(errorDetails));
      }, effectiveTimeout);

      this.pendingRequests.set(id, { 
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        }, 
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        }
      });
      
      this.ws.send(JSON.stringify(request));
    });
  }
}
