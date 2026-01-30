# Manual Installation Guide

## Obsidian Plugin

1. Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/px39n/obs_cursor/releases/latest)
2. Create folder `<your-vault>/.obsidian/plugins/cursor-integration/`
3. Copy the downloaded files into that folder
4. Restart Obsidian
5. Settings → Community Plugins → Enable "Cursor Integration"

## VS Code / Cursor Extension

### Option 1: From Marketplace (Recommended)
- **Cursor**: Search `obsidianpreview` in Extensions or [Install from OpenVSX](https://open-vsx.org/extension/px39n/obsidianpreview)
- **VS Code**: Search `obsidianpreview` in Extensions or [Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=px39n.obsidianpreview)

### Option 2: From VSIX file
1. Download the `.vsix` file from the [latest release](https://github.com/px39n/obs_cursor/releases/latest)
2. In Cursor/VS Code: `Ctrl+Shift+P` → "Extensions: Install from VSIX..."
3. Select the downloaded `.vsix` file

### Option 3: Command line
```bash
cursor --install-extension px39n.obsidianpreview
```

## Verify Installation

1. Open Obsidian with the plugin enabled
2. Open your vault in Cursor/VS Code
3. Open any `.md` file
4. Click the 👁️ icon in the editor title bar or run `Obsidian Preview: Open Preview`

If you see the rendered preview, everything is working!

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Render failed: Not connected" | Make sure Obsidian is running with the plugin enabled |
| Preview not updating | Close and reopen the preview panel |
| Links not working | Ensure the file exists in your vault |
