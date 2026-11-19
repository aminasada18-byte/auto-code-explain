import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export type ExplanationStatus = 'idle' | 'waiting' | 'loading' | 'success' | 'error';

export type ExplanationViewState = {
  enabled: boolean;
  status: ExplanationStatus;
  location?: string;
  text: string;
  canRetry?: boolean;
};

type ViewMessage =
  | { type: 'ready' }
  | { type: 'toggle' }
  | { type: 'toggleVariables' }
  | { type: 'retry' };

/** A single, persistent sidebar view for the latest explanation. */
export class ExplanationView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private showVariables = true;
  private state: ExplanationViewState = {
    enabled: false,
    status: 'idle',
    text: '启用自动解释后，选中一行或一段代码即可查看解释。',
  };

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onAction: (action: 'toggle' | 'toggleVariables' | 'retry') => void,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext<unknown>,
    _token: vscode.CancellationToken,
  ): void {
    this.disposeViewListeners();
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => {
        this.handleMessage(message);
      }),
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.sendState();
        }
      }),
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) {
          this.view = undefined;
        }
        this.disposeViewListeners();
      }),
    );
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
  }

  public setState(state: ExplanationViewState): void {
    this.state = {
      enabled: state.enabled,
      status: state.status,
      location: state.location,
      text: state.text,
      canRetry: state.canRetry,
    };
    this.sendState();
  }

  public setShowVariables(showVariables: boolean): void {
    this.showVariables = showVariables;
    this.sendState();
  }

  public dispose(): void {
    this.disposeViewListeners();
    this.view = undefined;
  }

  private disposeViewListeners(): void {
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private handleMessage(message: unknown): void {
    if (!this.isViewMessage(message)) {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.sendState();
        break;
      case 'toggle':
        this.onAction('toggle');
        break;
      case 'toggleVariables':
        this.onAction('toggleVariables');
        break;
      case 'retry':
        if (this.state.status === 'error' && this.state.canRetry) {
          this.onAction('retry');
        }
        break;
    }
  }

  private isViewMessage(message: unknown): message is ViewMessage {
    if (typeof message !== 'object' || message === null || !('type' in message)) {
      return false;
    }
    const type = (message as { type?: unknown }).type;
    return type === 'ready' || type === 'toggle' || type === 'toggleVariables' || type === 'retry';
  }

  private sendState(): void {
    if (this.view === undefined) {
      return;
    }
    void this.view.webview.postMessage({ type: 'state', state: { ...this.state, showVariables: this.showVariables } });
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = randomBytes(18).toString('base64');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'explain.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'explain.js'));

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${escapeAttribute(styleUri.toString())}">
  <title>代码解释</title>
</head>
<body>
  <main class="view" id="view">
    <section class="controls" aria-label="自动解释控制">
      <button class="primary" id="toggle" type="button">启用自动解释</button>
      <span class="status" id="status" role="status"></span>
    </section>
    <label class="variables"><input id="show-variables" type="checkbox" checked> 显示变量含义</label>
    <p class="location" id="location"></p>
    <section class="content" aria-label="解释结果">
      <p class="explanation" id="explanation"></p>
      <button class="secondary" id="retry" type="button" hidden>重新解释</button>
    </section>
  </main>
  <script nonce="${nonce}" src="${escapeAttribute(scriptUri.toString())}"></script>
</body>
</html>`;
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
