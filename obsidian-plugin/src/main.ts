import { Plugin, Notice } from "obsidian";
import { RenderServer } from "./server";

const DEFAULT_PORT = 27123;

export default class ObsidianRenderServerPlugin extends Plugin {
  private server: RenderServer | null = null;
  private styleEl: HTMLStyleElement | null = null;

  async onload(): Promise<void> {
    // Add CSS for offscreen rendering container
    this.styleEl = document.createElement("style");
    this.styleEl.textContent = `.obsidian-render-offscreen { position: absolute; left: -9999px; }`;
    document.head.appendChild(this.styleEl);

    this.server = new RenderServer(this.app, DEFAULT_PORT);
    await this.server.start();
    new Notice(`Render server started on port ${DEFAULT_PORT}`);

    this.addCommand({
      id: "restart-render-server",
      name: "Restart render server",
      callback: () => {
        this.server?.stop();
        this.server = new RenderServer(this.app, DEFAULT_PORT);
        this.server.start();
        new Notice(`Render server restarted on port ${DEFAULT_PORT}`);
      },
    });
  }

  onunload(): void {
    this.server?.stop();
    this.server = null;
    this.styleEl?.remove();
    this.styleEl = null;
  }
}
