import {
  App,
  MarkdownRenderer,
  Component,
  TFile,
} from "obsidian";

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
  const container = document.createElement("div");
  container.addClass("markdown-preview-view", "markdown-rendered", "obsidian-render-offscreen");
  document.body.appendChild(container);

  const component = new Component();
  component.load();

  const file = app.vault.getAbstractFileByPath(filePath);
  const sourcePath = file instanceof TFile ? file.path : "";

  await MarkdownRenderer.render(
    app,
    content,
    container,
    sourcePath,
    component
  );

  // Wait for plugins to process (Admonition, Dataview, etc.)
  await waitForPlugins(container);

  const html = container.innerHTML;
  const css = extractThemeCSS();

  // Cleanup
  document.body.removeChild(container);
  component.unload();

  return { html, css };
}

/**
 * Wait for plugins to finish processing the container.
 * Only waits if plugin content is detected.
 */
async function waitForPlugins(container: HTMLElement): Promise<void> {
  // Check if page has plugin content that needs waiting
  const hasDataview = container.querySelector(".block-language-dataview, .dataview") !== null;
  const hasAdmonition = container.querySelector(".callout, .admonition, .block-language-ad-") !== null;
  const hasEmbed = container.querySelector(".internal-embed") !== null;
  
  if (!hasDataview && !hasAdmonition && !hasEmbed) {
    // Simple page - minimal wait (just let render complete)
    await new Promise(r => setTimeout(r, 50));
    return;
  }
  
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
      await new Promise(r => setTimeout(r, 300));
    }
  }
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
