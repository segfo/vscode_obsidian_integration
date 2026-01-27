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
        const response: ResponseMessage = JSON.parse(data.toString());
        // Simple response handling (no request ID in current protocol)
        const pending = this.pendingRequests.values().next().value;
        if (pending) {
          pending.resolve(response);
          this.pendingRequests.delete(
            this.pendingRequests.keys().next().value!
          );
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
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const id = ++this.requestId;
      
      // Timeout handling
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error("Request timeout"));
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
