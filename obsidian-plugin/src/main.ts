import { Plugin, Notice } from "obsidian";
import { RenderServer } from "./server";
import { logger } from "./logger";

const DEFAULT_PORT = 27123;

export default class ObsidianRenderServerPlugin extends Plugin {
  private server: RenderServer | null = null;

  async onload(): Promise<void> {
    logger.info("Plugin loading...");
    this.server = new RenderServer(this.app, DEFAULT_PORT);
    await this.server.start();
    logger.info(`Server started on port ${DEFAULT_PORT}`);
    new Notice(`Render server started on port ${DEFAULT_PORT}`);

    this.addCommand({
      id: "restart-render-server",
      name: "Restart render server",
      callback: () => {
        this.server?.stop();
        this.server = new RenderServer(this.app, DEFAULT_PORT);
        void this.server.start();
        new Notice(`Render server restarted on port ${DEFAULT_PORT}`);
      },
    });
  }

  onunload(): void {
    this.server?.stop();
    this.server = null;
  }
}
