# Installation Guide

## Recommended: Auto Install (One Step)

1. Search `obsidianpreview` in Cursor/VS Code Extensions and install
2. Open your vault folder in Cursor/VS Code
3. Open any `.md` file → run `Obsidian Preview: Open Preview`

> The extension will auto-detect your vault, install the Obsidian plugin, and launch Obsidian — all automatically.

To update the Obsidian plugin later: `Ctrl+Shift+P` → `Obsidian Preview: Update Obsidian Plugin`

---

## Manual Installation

### Obsidian Plugin

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/segfo/vscode_obsidian_integration/releases/latest)
2. Create folder `<your-vault>/.obsidian/plugins/cursor-integration/`
3. Copy `main.js` and `manifest.json` into that folder
4. Restart Obsidian
5. Settings → Community Plugins → Enable **Cursor Integration**


## Verify Installation

1. Open your vault in Cursor/VS Code
2. Open any `.md` file
3. Click the 👁️ icon or run `Obsidian Preview: Open Preview`

If you see the rendered preview, everything is working!

## Troubleshooting

| Issue                  | Solution                                                       |
| ---------------------- | -------------------------------------------------------------- |
| "No Vault Configured"  | Run `Obsidian Preview: Update Vault Path` to set it          |
| "Connection Timed Out" | Make sure the Cursor Integration plugin is enabled in Obsidian |
| Preview not updating   | Close and reopen the preview panel, or click the 🔄 button     |
| Links not working      | Ensure the file exists in your vault                           |
