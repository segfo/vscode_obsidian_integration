import WebSocket from "ws";

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

type ResponseMessage = RenderResponse | ResolveResponse | ErrorResponse;

export class ObsidianClient {
  private ws: WebSocket | null = null;
  private port: number;
  private pendingRequests: Map<
    number,
    { resolve: (value: ResponseMessage) => void; reject: (err: Error) => void }
  > = new Map();
  private requestId = 0;
  private disconnectCallbacks: Array<() => void> = [];

  constructor(port: number) {
    this.port = port;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://localhost:${this.port}`);

      this.ws.on("open", () => {
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

  private sendRequest(request: object, timeoutMs: number = 10000): Promise<ResponseMessage> {
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
      const requestType = (request as { type?: string }).type || "unknown";
      const pendingCount = this.pendingRequests.size;
      
      console.log(`[ObsidianClient] Sending request #${id} type=${requestType}, pending=${pendingCount}`);
      
      // Timeout handling
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timeout (10s) for ${requestType} request #${id}. Pending requests: ${this.pendingRequests.size}. Check Obsidian console for errors.`));
      }, timeoutMs);

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
