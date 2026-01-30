import { Plugin, Notice, PluginSettingTab, App, Setting } from "obsidian";
import { RenderServer } from "./server";
import { logger } from "./logger";
import { exec } from "child_process";

const DEFAULT_PORT = 27123;
const DEFAULT_RENDER_TIMEOUT = 30;
const DEFAULT_TYPING_DELAY = 0.3;
const DEFAULT_UPDATE_DELAY = 0.2;
const DEFAULT_MONITOR_TIME = 5;

interface CursorIntegrationSettings {
  port: number;
  renderTimeout: number;
  typingDelay: number;
  updateDelay: number;
  monitorTime: number;
}

const DEFAULT_SETTINGS: CursorIntegrationSettings = {
  port: DEFAULT_PORT,
  renderTimeout: DEFAULT_RENDER_TIMEOUT,
  typingDelay: DEFAULT_TYPING_DELAY,
  updateDelay: DEFAULT_UPDATE_DELAY,
  monitorTime: DEFAULT_MONITOR_TIME,
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
      .setDesc("Maximum time (seconds) to wait for render() to return")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.renderTimeout))
          .onChange(async (value) => {
            const val = parseFloat(value);
            if (!isNaN(val) && val > 0) {
              this.plugin.settings.renderTimeout = val;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Typing delay")
      .setDesc("Wait this long (seconds) after user stops typing before sending render request")
      .addText((text) =>
        text
          .setPlaceholder("0.3")
          .setValue(String(this.plugin.settings.typingDelay))
          .onChange(async (value) => {
            const val = parseFloat(value);
            if (!isNaN(val) && val >= 0) {
              this.plugin.settings.typingDelay = val;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Update delay")
      .setDesc("After DOM changes, wait this long (seconds) with no new changes before sending update")
      .addText((text) =>
        text
          .setPlaceholder("0.2")
          .setValue(String(this.plugin.settings.updateDelay))
          .onChange(async (value) => {
            const val = parseFloat(value);
            if (!isNaN(val) && val >= 0) {
              this.plugin.settings.updateDelay = val;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Monitor time")
      .setDesc("How long (seconds) to monitor DOM for changes after render completes")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.monitorTime))
          .onChange(async (value) => {
            const val = parseFloat(value);
            if (!isNaN(val) && val >= 0) {
              this.plugin.settings.monitorTime = val;
              await this.plugin.saveSettings();
            }
          })
      );
  }
}
