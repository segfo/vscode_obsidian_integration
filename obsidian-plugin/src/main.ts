import { Plugin, Notice, PluginSettingTab, App, Setting } from "obsidian";
import { RenderServer } from "./server";
import { logger } from "./logger";
import { exec } from "child_process";

const DEFAULT_PORT = 27123;
const DEFAULT_RENDER_TIMEOUT = 30;
const DEFAULT_RENDER_GRACE_PERIOD = 5;

interface CursorIntegrationSettings {
  port: number;
  renderTimeout: number;
  renderGracePeriod: number;
}

const DEFAULT_SETTINGS: CursorIntegrationSettings = {
  port: DEFAULT_PORT,
  renderTimeout: DEFAULT_RENDER_TIMEOUT,
  renderGracePeriod: DEFAULT_RENDER_GRACE_PERIOD,
};

export default class ObsidianRenderServerPlugin extends Plugin {
  private server: RenderServer | null = null;
  settings: CursorIntegrationSettings = DEFAULT_SETTINGS;

  async onload(): Promise<void> {
    logger.info("Plugin loading...");
    
    await this.loadSettings();
    this.addSettingTab(new CursorIntegrationSettingTab(this.app, this));

    this.server = new RenderServer(this.app, this.settings);
    await this.server.start();
    logger.info(`Server started on port ${this.settings.port}`);
    new Notice(`Render server started on port ${this.settings.port}`);

    this.addCommand({
      id: "restart-render-server",
      name: "Restart render server",
      callback: () => {
        this.server?.stop();
        this.server = new RenderServer(this.app, this.settings);
        void this.server.start();
        new Notice(`Render server restarted on port ${this.settings.port}`);
      },
    });

    this.addCommand({
      id: "open-vault-in-cursor",
      name: "Open vault in Cursor",
      callback: () => {
        this.openInCursor();
      },
    });
  }

  onunload(): void {
    this.server?.stop();
    this.server = null;
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() as Partial<CursorIntegrationSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private openInCursor(): void {
    const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
    if (!vaultPath) {
      new Notice("Could not determine vault path");
      return;
    }

    // Try cursor first, then code
    exec(`cursor "${vaultPath}"`, (error) => {
      if (error) {
        new Notice(
          "Cursor command not found. Please install Cursor CLI:\n" +
          "Open Cursor → Cmd/Ctrl+Shift+P → 'Install cursor command'"
        );
        logger.warn("Cursor command failed, CLI not installed");
      } else {
        new Notice("Opening vault in Cursor...");
        logger.info(`Opened vault in Cursor: ${vaultPath}`);
      }
    });
  }
}

class CursorIntegrationSettingTab extends PluginSettingTab {
  plugin: ObsidianRenderServerPlugin;

  constructor(app: App, plugin: ObsidianRenderServerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Server port")
      .setDesc("Port for the render server (requires plugin restart)")
      .addText((text) =>
        text
          .setPlaceholder("27123")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (value) => {
            const port = parseInt(value, 10);
            if (!isNaN(port) && port > 0 && port < 65536) {
              this.plugin.settings.port = port;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Render timeout")
      .setDesc("Maximum time (seconds) to wait for a render response before showing an error")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.renderTimeout))
          .onChange(async (value) => {
            const timeout = parseInt(value, 10);
            if (!isNaN(timeout) && timeout > 0) {
              this.plugin.settings.renderTimeout = timeout;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Render grace period")
      .setDesc("When a new render request arrives, wait for the current render to finish if it has been running less than this time (seconds)")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.renderGracePeriod))
          .onChange(async (value) => {
            const gracePeriod = parseInt(value, 10);
            if (!isNaN(gracePeriod) && gracePeriod >= 0) {
              this.plugin.settings.renderGracePeriod = gracePeriod;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
