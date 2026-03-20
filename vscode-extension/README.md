# Obsidian for Cursor

> **Preview & navigate your Obsidian vault while coding with AI.**

![License](https://img.shields.io/badge/license-MIT-blue.svg)

---

## Why?

Cursor/VS Code is great for AI-assisted editing. Obsidian is great for knowledge management. This plugin bridges them — **preview your notes with full Obsidian rendering while you code**.

---

## Features

![Demo](assets/Animation.gif)

- **Live Preview** — Dataview, Admonition, callouts, all rendered
- **Click to Navigate** — `[[wikilinks]]` and `[[File#Heading]]` work, with back button
- **Hover Preview** — See linked notes without switching files
- **Syntax Highlighting** — Wikilinks, tags, embeds colored in editor
- **Wikilink Completion** — Type `[[` to get file suggestions with alias support
- **Collapsible Callouts** — Expand/collapse just like Obsidian
- **Auto Launch** — Automatically detects vault, launches Obsidian, and installs/updates the plugin

---

## Install

**Strongly Recommended — one step for everything:**

Search `obsidianpreview` in Cursor/VS Code Extensions and install. That's it.

> On first use, the extension auto-detects your vault, installs the Obsidian plugin, and launches Obsidian for you.

For manual installation, see the [Manual Installation Guide](https://github.com/segfo/vscode_obsidian_integration/blob/main/INSTALL.md).

---

## Usage

1. Open your vault folder in Cursor/VS Code
2. Open any `.md` file → Click the 👁️ icon or run `Obsidian Preview: Open Preview`
3. Everything is handled automatically — Obsidian will launch if needed

### Commands

| Command | Description |
|---------|-------------|
| `Obsidian Preview: Open Preview` | Open the preview panel |
| `Obsidian Preview: Open Obsidian Vault` | Launch Obsidian |
| `Obsidian Preview: Update Obsidian Plugin` | Check for and install plugin updates |
| `Obsidian Preview: Update Vault Path` | Change the detected vault path |

---

## License

MIT
