import * as vscode from "vscode";

type LinkClickCallback = (targetPath: string) => void;
type HoverPreviewCallback = (targetPath: string) => Promise<{ html: string; css: string } | null>;

export class PreviewPanel {
  private static readonly viewType = "obsidianPreview";
  private readonly panel: vscode.WebviewPanel;
  private linkClickCallbacks: LinkClickCallback[] = [];
  private hoverPreviewCallback: HoverPreviewCallback | null = null;
  private disposeCallbacks: (() => void)[] = [];
  private debugMode: boolean = false;

  private constructor(
    panel: vscode.WebviewPanel,
    _extensionUri: vscode.Uri,
    debugMode: boolean = false
  ) {
    this.panel = panel;
    this.debugMode = debugMode;

    this.panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === "linkClick") {
        this.linkClickCallbacks.forEach((cb) => cb(message.targetPath));
      } else if (message.type === "hoverPreview") {
        if (this.hoverPreviewCallback) {
          const result = await this.hoverPreviewCallback(message.targetPath);
          if (result) {
            this.panel.webview.postMessage({
              type: "hoverPreviewResult",
              targetPath: message.targetPath,
              html: result.html,
              x: message.x,
              y: message.y,
            });
          }
        }
      } else if (message.type === "hoverEnd") {
        // Preview will handle hiding itself
      }
    });

    // Handle panel dispose
    this.panel.onDidDispose(() => {
      this.disposeCallbacks.forEach((cb) => cb());
    });
  }

  static create(extensionUri: vscode.Uri, debugMode: boolean = false): PreviewPanel {
    const panel = vscode.window.createWebviewPanel(
      PreviewPanel.viewType,
      debugMode ? "Obsidian Preview (Debug)" : "Obsidian Preview",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    return new PreviewPanel(panel, extensionUri, debugMode);
  }

  updateContent(html: string, css: string): void {
    // Debug: log HTML size
    if (this.debugMode) {
      console.log(`[Preview] Received HTML: ${html.length} chars`);
      console.log(`[Preview] First 500 chars:`, html.substring(0, 500));
      // Check for dataview content
      const dvMatch = html.match(/class="dataview[^"]*"[^>]*>[\s\S]{0,300}/g);
      if (dvMatch) {
        console.log(`[Preview] Dataview matches:`, dvMatch.slice(0, 3));
      }
    }
    this.panel.webview.html = this.getWebviewContent(html, css);
  }

  onLinkClick(callback: LinkClickCallback): void {
    this.linkClickCallbacks.push(callback);
  }

  onHoverPreview(callback: HoverPreviewCallback): void {
    this.hoverPreviewCallback = callback;
  }

  onDispose(callback: () => void): void {
    this.disposeCallbacks.push(callback);
  }

  dispose(): void {
    this.panel.dispose();
  }

  private getWebviewContent(html: string, css: string): string {
    const debugPanel = this.debugMode ? `
    <div id="debug-panel" style="position:fixed;top:0;left:0;right:0;background:#ffeb3b;color:#000;padding:10px;font-family:monospace;font-size:12px;z-index:9999;border-bottom:2px solid #f57c00;">
      Debug Mode: Click anywhere to see element info
    </div>` : '';
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    /* Base styles - white background by default */
    :root {
      --background-primary: #ffffff;
      --background-secondary: #f5f5f5;
      --text-normal: #333333;
      --text-muted: #666666;
      --text-accent: #0969da;
      --interactive-accent: #0550ae;
    }
    
    body {
      background-color: var(--background-primary);
      color: var(--text-normal);
      padding: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.6;
    }
    
    /* Link styles */
    a, .internal-link, .cm-hmd-internal-link {
      color: var(--text-accent);
      text-decoration: none;
      cursor: pointer;
    }
    
    a:hover, .internal-link:hover {
      text-decoration: underline;
    }
    
    /* Admonition/Callout collapse styles */
    .admonition-title, .callout-title, .admonition-title-content {
      cursor: pointer;
      user-select: none;
    }
    
    .admonition.is-collapsed .admonition-content,
    .callout.is-collapsed .callout-content {
      display: none;
    }
    
    .callout-fold, .admonition-collapse-icon {
      cursor: pointer;
    }
    
    /* Embed styles - prevent extra whitespace */
    .internal-embed,
    .markdown-embed,
    .markdown-embed-content,
    .markdown-embed-content > .markdown-preview-view,
    .markdown-embed .markdown-preview-view,
    .markdown-embed-content .markdown-preview-view.markdown-rendered,
    .markdown-embed-content .markdown-preview-view.show-indentation-guide,
    span.internal-embed .markdown-embed,
    span.internal-embed .markdown-embed-content,
    span.internal-embed .markdown-preview-view {
      display: block !important;
      position: relative !important;
      min-height: 0 !important;
      max-height: none !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      border: none !important;
      overflow: visible !important;
    }
    
    .internal-embed {
      margin: 8px 0 !important;
    }
    
    /* Hover preview popup */
    #hover-preview {
      position: fixed;
      display: none;
      background: var(--background-primary);
      border: 1px solid #ccc;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      max-width: 400px;
      max-height: 300px;
      overflow: auto;
      padding: 12px;
      z-index: 10000;
      font-size: 13px;
    }
    
    #hover-preview .preview-title {
      font-weight: bold;
      margin-bottom: 8px;
      padding-bottom: 8px;
      border-bottom: 1px solid #eee;
    }
    
    ${css}
  </style>
  <style>
    /* Override Obsidian's embed styles - MUST be after Obsidian CSS */
    .internal-embed,
    .markdown-embed,
    .markdown-embed-content,
    .markdown-embed-content > .markdown-preview-view,
    .markdown-embed .markdown-preview-view,
    .markdown-embed-content .markdown-preview-view.markdown-rendered,
    .markdown-embed-content .markdown-preview-view.show-indentation-guide {
      min-height: 0 !important;
      max-height: none !important;
      height: auto !important;
      position: relative !important;
      overflow: visible !important;
    }
  </style>
</head>
<body class="theme-light">
  ${debugPanel}
  <div class="markdown-preview-view markdown-rendered" style="${this.debugMode ? 'margin-top:50px;' : ''}">
    ${html}
  </div>
  <div id="hover-preview"></div>
  <script>
    const vscode = acquireVsCodeApi();
    const isDebugMode = ${this.debugMode};
    
    // Handle Admonition/Callout collapse
    function toggleAdmonition(container) {
      if (!container) return false;
      
      // Check current state
      var isCollapsed = container.classList.contains('is-collapsed');
      
      // Find content element
      var content = container.querySelector('.callout-content, .admonition-content, .admonition-content-holder');
      
      if (isCollapsed) {
        // Expand: remove collapsed class, show content
        container.classList.remove('is-collapsed');
        if (content) {
          content.style.display = 'block';
          content.style.visibility = 'visible';
          content.style.height = 'auto';
        }
      } else {
        // Collapse: add collapsed class, hide content
        container.classList.add('is-collapsed');
        if (content) {
          content.style.display = 'none';
        }
      }
      
      return true;
    }
    
    // Update debug panel
    function updateDebug(msg) {
      var panel = document.getElementById('debug-panel');
      if (panel) {
        panel.innerHTML = msg;
        panel.style.background = '#4caf50';
      }
    }
    
    // Click handler
    document.body.addEventListener('click', function(e) {
      var t = e.target;
      
      // Debug info
      if (isDebugMode) {
        var info = 'Clicked: ' + t.tagName + ' | Class: ' + (t.className || 'none');
        if (t.parentElement) {
          info += ' | Parent: ' + t.parentElement.tagName + '.' + (t.parentElement.className || 'none');
        }
        // Show innerHTML (truncated)
        var inner = t.innerHTML || t.textContent || '(empty)';
        if (inner.length > 100) inner = inner.substring(0, 100) + '...';
        info += ' | Content: ' + inner.replace(/</g, '&lt;');
        // Show all attributes
        var attrs = [];
        for (var i = 0; i < t.attributes.length; i++) {
          var attr = t.attributes[i];
          attrs.push(attr.name + '="' + attr.value + '"');
        }
        if (attrs.length > 0) {
          info += ' | Attrs: ' + attrs.join(', ');
        }
        // Check first child
        if (t.firstElementChild) {
          var child = t.firstElementChild;
          var childAttrs = [];
          for (var j = 0; j < child.attributes.length; j++) {
            childAttrs.push(child.attributes[j].name + '="' + child.attributes[j].value + '"');
          }
          info += ' | Child: ' + child.tagName + ' [' + childAttrs.join(', ') + '] text="' + (child.textContent || '') + '"';
        }
        updateDebug(info);
      }
      
      // Check if clicked on admonition title area
      var admonitionTitle = t.closest('.callout-title, .admonition-title, .callout-title-inner, .admonition-title-content');
      if (admonitionTitle) {
        e.preventDefault();
        e.stopPropagation();
        // Find the main container
        var container = admonitionTitle.closest('.callout, .admonition, [class*="admonition-plugin"]');
        if (container) {
          toggleAdmonition(container);
          if (isDebugMode) {
            updateDebug('Toggled! Container: ' + container.className);
          }
        }
        return;
      }
      
      // Handle links
      var link = t.closest('a');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        var targetPath = link.getAttribute('data-href') || link.getAttribute('href') || link.textContent;
        if (targetPath && targetPath.indexOf('http') !== 0) {
          vscode.postMessage({ type: 'linkClick', targetPath: targetPath });
        }
      }
    });
    
    // Hover preview functionality
    var hoverPreview = document.getElementById('hover-preview');
    var hoverTimeout = null;
    var currentHoverLink = null;
    
    // Listen for hover preview results from extension
    window.addEventListener('message', function(e) {
      var msg = e.data;
      if (msg.type === 'hoverPreviewResult') {
        showHoverPreview(msg.html, msg.x, msg.y, msg.targetPath);
      }
    });
    
    function showHoverPreview(html, x, y, title) {
      if (!hoverPreview) return;
      
      // Extract just the content, limit size
      var tempDiv = document.createElement('div');
      tempDiv.innerHTML = html;
      var previewContent = tempDiv.innerHTML;
      if (previewContent.length > 5000) {
        previewContent = previewContent.substring(0, 5000) + '...';
      }
      
      hoverPreview.innerHTML = '<div class="preview-title">' + (title || 'Preview') + '</div>' + previewContent;
      
      // Position the preview
      var viewportWidth = window.innerWidth;
      var viewportHeight = window.innerHeight;
      
      hoverPreview.style.display = 'block';
      
      var previewWidth = hoverPreview.offsetWidth;
      var previewHeight = hoverPreview.offsetHeight;
      
      // Adjust position to stay in viewport
      var left = x + 10;
      var top = y + 10;
      
      if (left + previewWidth > viewportWidth - 20) {
        left = x - previewWidth - 10;
      }
      if (top + previewHeight > viewportHeight - 20) {
        top = viewportHeight - previewHeight - 20;
      }
      if (left < 10) left = 10;
      if (top < 10) top = 10;
      
      hoverPreview.style.left = left + 'px';
      hoverPreview.style.top = top + 'px';
    }
    
    function hideHoverPreview() {
      if (hoverPreview) {
        hoverPreview.style.display = 'none';
      }
      currentHoverLink = null;
    }
    
    // Add hover listeners to links
    document.body.addEventListener('mouseenter', function(e) {
      var link = e.target.closest('a.internal-link, a[data-href]');
      if (link && link !== currentHoverLink) {
        currentHoverLink = link;
        
        // Delay before showing preview
        clearTimeout(hoverTimeout);
        hoverTimeout = setTimeout(function() {
          var targetPath = link.getAttribute('data-href') || link.getAttribute('href');
          if (targetPath && targetPath.indexOf('http') !== 0) {
            var rect = link.getBoundingClientRect();
            vscode.postMessage({
              type: 'hoverPreview',
              targetPath: targetPath,
              x: rect.right,
              y: rect.top
            });
          }
        }, 200); // 200ms delay
      }
    }, true);
    
    document.body.addEventListener('mouseleave', function(e) {
      var link = e.target.closest('a.internal-link, a[data-href]');
      if (link) {
        clearTimeout(hoverTimeout);
        // Delay before hiding to allow moving to preview
        setTimeout(function() {
          if (!hoverPreview.matches(':hover')) {
            hideHoverPreview();
          }
        }, 100);
      }
    }, true);
    
    // Hide preview when mouse leaves the preview itself
    if (hoverPreview) {
      hoverPreview.addEventListener('mouseleave', function() {
        hideHoverPreview();
      });
    }
  </script>
</body>
</html>`;
  }
}
