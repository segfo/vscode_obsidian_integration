import WebSocket from "ws";
import { Logger } from "./logger";

export interface RenderResponse {
  type: "render";
  html: string;
  css: string;
  filePath?: string;
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
}

export interface ErrorResponse {
  type: "error";
  message: string;
}

export interface RestartedResponse {
  type: "restarted";
}

export interface ImgurConfigResponse {
  type: "imgurConfig";
  available: boolean;
  clientId?: string;
  accessToken?: string;
  uploadStrategy?: string;
}

type ResponseMessage = RenderResponse | ResolveResponse | SettingsResponse | ErrorResponse | RestartedResponse | ImgurConfigResponse;

export type RenderUpdateCallback = (response: RenderResponse) => void;

export class ObsidianClient {
  private ws: WebSocket | null = null;
  private port: number;
  private pendingRequests: Map<
    number,
    { resolve: (value: ResponseMessage) => void; reject: (err: Error) => void }
  > = new Map();
  private requestId = 0;
  private disconnectCallbacks: Array<() => void> = [];
  private renderUpdateCallbacks: RenderUpdateCallback[] = [];
  private renderTimeoutMs = 60000;
  private typingDelayMs = 300;

  constructor(port: number) {
    this.port = port;
  }

  getTypingDelayMs(): number {
    return this.typingDelayMs;
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
          
          // Handle render updates (pushed from server)
          if (response.type === "render" && response.isUpdate) {
            console.log(`[ObsidianClient] Render update for: ${response.filePath}`);
            this.renderUpdateCallbacks.forEach((cb) => cb(response));
            return;
          }
          
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

  async getImgurConfig(): Promise<ImgurConfigResponse | null> {
    try {
      const response = await this.sendRequest({ type: "getImgurConfig" }, 5000);
      if (response.type === "imgurConfig") {
        return response as ImgurConfigResponse;
      }
      return null;
    } catch (err) {
      console.warn("[ObsidianClient] Failed to get imgur config:", err);
      return null;
    }
  }

  async restart(): Promise<void> {
    console.log("[ObsidianClient] Sending restart request");
    
    // Send restart request - server will disconnect, so we don't wait for response
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "restart" }));
    }
    
    // Wait for disconnect
    await new Promise<void>((resolve) => {
      const checkDisconnect = () => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
          resolve();
        } else {
          setTimeout(checkDisconnect, 100);
        }
      };
      setTimeout(checkDisconnect, 100);
      // Timeout after 2 seconds
      setTimeout(resolve, 2000);
    });
    
    // Clear pending requests
    this.pendingRequests.forEach((pending) => {
      pending.reject(new Error("Server restarted"));
    });
    this.pendingRequests.clear();
    
    // Wait a bit for server to restart
    await new Promise((r) => setTimeout(r, 500));
    
    // Reconnect
    console.log("[ObsidianClient] Reconnecting after restart");
    await this.connect();
    console.log("[ObsidianClient] Reconnected successfully");
  }

  onDisconnect(callback: () => void): void {
    this.disconnectCallbacks.push(callback);
  }

  onRenderUpdate(callback: RenderUpdateCallback): void {
    this.renderUpdateCallbacks.push(callback);
  }

  private async fetchSettings(): Promise<void> {
    try {
      const response = await this.sendRequest({ type: "getSettings" }, 5000);
      if (response.type === "settings") {
        this.renderTimeoutMs = response.renderTimeout * 1000;
        this.typingDelayMs = response.typingDelay * 1000;
        console.log(`[ObsidianClient] Settings: renderTimeout=${response.renderTimeout}s, typingDelay=${response.typingDelay}s`);
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
