import {
  App,
  MarkdownRenderer,
  Component,
  TFile,
} from "obsidian";
import { logger } from "./logger";

export interface RenderResult {
  html: string;
  css: string;
}

export interface LinkInfo {
  displayText: string;
  targetPath: string;
}

/**
 * Render markdown content using Obsidian's renderer.
 * Waits for plugins (like Admonition, Dataview) to finish processing.
 */
export async function renderMarkdown(
  app: App,
  filePath: string,
  content: string
): Promise<RenderResult> {
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const startTime = Date.now();
  
  const container = document.createElement("div");
  container.addClass("markdown-preview-view", "markdown-rendered", "obsidian-render-offscreen");
  document.body.appendChild(container);

  const component = new Component();
  component.load();

  const file = app.vault.getAbstractFileByPath(filePath);
  const sourcePath = file instanceof TFile ? file.path : "";

  const renderStart = Date.now();
  await MarkdownRenderer.render(
    app,
    content,
    container,
    sourcePath,
    component
  );
  const renderTime = Date.now() - renderStart;

  // Wait for plugins to process (Admonition, Dataview, etc.)
  const pluginStart = Date.now();
  const pluginInfo = await waitForPlugins(container, fileName);
  const pluginTime = Date.now() - pluginStart;

  const html = container.innerHTML;
  const css = extractThemeCSS();

  // Cleanup
  document.body.removeChild(container);
  component.unload();

  const totalTime = Date.now() - startTime;
  if (totalTime > 500) {
    logger.warn(`Slow render: ${fileName} took ${totalTime}ms (render: ${renderTime}ms, plugins: ${pluginTime}ms) [${pluginInfo}]`);
  }

  return { html, css };
}

/**
 * Wait for plugins to finish processing the container.
 * Only waits if plugin content is detected.
 * Returns a string describing what plugins were detected.
 */
async function waitForPlugins(container: HTMLElement, fileName: string): Promise<string> {
  // Check if page has plugin content that needs waiting
  const hasDataview = container.querySelector(".block-language-dataview, .dataview") !== null;
  const hasAdmonition = container.querySelector(".callout, .admonition, .block-language-ad-") !== null;
  const hasEmbed = container.querySelector(".internal-embed") !== null;
  const hasTableExtended = container.querySelector(".block-language-tx, .table-extended") !== null;
  
  const detected: string[] = [];
  if (hasDataview) detected.push("dataview");
  if (hasAdmonition) detected.push("callout");
  if (hasEmbed) detected.push("embed");
  if (hasTableExtended) detected.push("table-extended");
  
  if (detected.length === 0) {
    // Simple page - minimal wait (just let render complete)
    await new Promise(r => setTimeout(r, 50));
    return "simple";
  }
  
  const pluginInfo = detected.join("+");
  logger.debug(`${fileName}: detected [${pluginInfo}]`);
  
  // Has plugins - wait for mutations to settle
  // Embed needs more time because it loads external content
  const debounceMs = hasDataview ? 300 : (hasEmbed ? 200 : 100);
  const maxWaitMs = hasDataview ? 1500 : (hasEmbed ? 1000 : 500);
  
  await waitForMutations(container, debounceMs, maxWaitMs);
  
  // If Dataview, check for empty spans
  if (hasDataview) {
    for (let retry = 0; retry < 3; retry++) {
      const emptySpans = container.querySelectorAll("td span:empty, .dataview span:empty");
      if (emptySpans.length === 0) break;
      logger.debug(`${fileName}: dataview retry ${retry + 1}, ${emptySpans.length} empty spans`);
      await new Promise(r => setTimeout(r, 300));
    }
  }
  
  return pluginInfo;
}

/**
 * Wait for DOM mutations to settle.
 */
async function waitForMutations(
  container: HTMLElement,
  debounceMs: number,
  maxWaitMs: number
): Promise<void> {
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout>;
    let settled = false;

    const observer = new MutationObserver(() => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          observer.disconnect();
          resolve();
        }
      }, debounceMs);
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });

    // Max wait time
    timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        observer.disconnect();
        resolve();
      }
    }, maxWaitMs);
  });
}

/**
 * Extract current Obsidian theme CSS.
 */
function extractThemeCSS(): string {
  const styles: string[] = [];

  // Collect all stylesheets
  for (let i = 0; i < document.styleSheets.length; i++) {
    const sheet = document.styleSheets[i];
    try {
      if (sheet.cssRules) {
        for (let j = 0; j < sheet.cssRules.length; j++) {
          styles.push(sheet.cssRules[j].cssText);
        }
      }
    } catch {
      // Skip inaccessible stylesheets (cross-origin)
    }
  }

  return styles.join("\n");
}

/**
 * Resolve wikilink to actual file path.
 */
export function resolveWikilink(
  app: App,
  link: string,
  currentFile: string
): LinkInfo {
  // Parse [[link]] or [[link|alias]]
  const pipeIndex = link.indexOf("|");
  const targetLink = pipeIndex >= 0 ? link.substring(0, pipeIndex) : link;
  const displayText = pipeIndex >= 0 ? link.substring(pipeIndex + 1) : link;

  // Resolve using Obsidian's metadata cache
  const sourceFile = app.vault.getAbstractFileByPath(currentFile);
  const resolvedFile = app.metadataCache.getFirstLinkpathDest(
    targetLink,
    sourceFile instanceof TFile ? sourceFile.path : ""
  );

  const targetPath = resolvedFile?.path ?? "";

  return { displayText, targetPath };
}
