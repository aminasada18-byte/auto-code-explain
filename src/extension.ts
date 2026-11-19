import { basename } from 'node:path';
import * as vscode from 'vscode';
import { ExplanationView } from './explanationView';
import { ExplanationModel, ModelSetupError } from './model';
import { collectProjectContext } from './projectContext';

const enablementKey = 'autoCodeExplain.enabledWithProjectContext';
const showVariablesKey = 'autoCodeExplain.showVariables';
const toggleCommand = 'autoCodeExplain.toggle';
const viewId = 'autoCodeExplain.explanation';
const selectionDelay = 500;
const maximumCharacters = 12_000;

interface SelectedCode {
  editor: vscode.TextEditor;
  range: vscode.Range;
  version: number;
  languageId: string;
  location: string;
  code: string;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(new AutomaticExplanation(context));
}

class AutomaticExplanation implements vscode.Disposable {
  private readonly model: ExplanationModel;
  private readonly view: ExplanationView;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
  private readonly listeners: vscode.Disposable;
  private enabled: boolean;
  private showVariables: boolean;
  private changingMode = false;
  private revealedView = false;
  private selection?: SelectedCode;
  private timer?: ReturnType<typeof setTimeout>;
  private request?: vscode.CancellationTokenSource;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.enabled = context.globalState.get(enablementKey, false);
    this.showVariables = context.globalState.get(showVariablesKey, true);
    this.model = new ExplanationModel(context.languageModelAccessInformation);
    this.view = new ExplanationView(context.extensionUri, (action) => {
      if (action === 'toggle') {
        void this.toggle();
      } else if (action === 'toggleVariables') {
        this.toggleVariables();
      } else if (this.selection && this.isCurrentSelection(this.selection)) {
        void this.explain(this.selection, true);
      }
    });
    this.view.setShowVariables(this.showVariables);
    this.status.name = '自动代码解释';
    this.status.command = toggleCommand;
    this.updateStatus();
    this.status.show();
    this.showIdle();

    this.listeners = vscode.Disposable.from(
      this.view,
      this.status,
      vscode.window.registerWebviewViewProvider(viewId, this.view),
      vscode.commands.registerCommand(toggleCommand, () => this.toggle()),
      vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => this.onSelection(textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (this.selection && this.selection.editor !== editor) {
          this.clearSelection();
        }
      }),
      vscode.workspace.onDidChangeTextDocument(({ document }) => {
        if (this.selection?.editor.document === document && this.selection.version !== document.version) {
          this.clearSelection();
        }
      }),
    );
  }

  dispose(): void {
    this.enabled = false;
    this.cancelWork();
    this.listeners.dispose();
  }

  private async toggle(): Promise<void> {
    if (this.changingMode) {
      return;
    }

    this.changingMode = true;
    try {
      if (this.enabled) {
        this.enabled = false;
        this.revealedView = false;
        this.clearSelection();
        this.updateStatus();
        await this.context.globalState.update(enablementKey, false);
        return;
      }

      const confirmation = await vscode.window.showInformationMessage(
        '启用结合项目上下文的代码解释？',
        { modal: true, detail: '生成解释时，GitHub Copilot 会收到选区、当前文件的相关内容，以及解析到的少量项目源码片段。' },
        '启用',
      );
      if (confirmation !== '启用') {
        return;
      }

      await this.model.authorize();
      await this.context.globalState.update(enablementKey, true);
      this.enabled = true;
      this.updateStatus();
      this.showIdle();
      void this.revealView();
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        this.onSelection(editor);
      }
    } catch (error) {
      const message = error instanceof ModelSetupError ? error.message : '无法更改自动解释状态，请重试。';
      void vscode.window.showErrorMessage(message);
    } finally {
      this.changingMode = false;
    }
  }

  private toggleVariables(): void {
    this.showVariables = !this.showVariables;
    this.view.setShowVariables(this.showVariables);
    void this.context.globalState.update(showVariablesKey, this.showVariables).then(undefined, () => {
      void vscode.window.showErrorMessage('未能保存「显示变量含义」设置。');
    });
    if (this.selection && this.isCurrentSelection(this.selection)) {
      void this.explain(this.selection);
    }
  }

  private onSelection(editor: vscode.TextEditor): void {
    if (!this.enabled || editor !== vscode.window.activeTextEditor) {
      return;
    }

    if (this.selection && this.isCurrentSelection(this.selection)) {
      return;
    }

    this.cancelWork();
    this.selection = undefined;
    const range = editor.selection;
    if (range.isEmpty || editor.selections.length !== 1) {
      this.showIdle();
      return;
    }

    const { document } = editor;
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    if (end - start > maximumCharacters) {
      this.showIdle('选区超过 12,000 字符，请缩小选区。');
      return;
    }

    const code = document.getText(range);
    if (!code.trim()) {
      this.showIdle();
      return;
    }

    const selection: SelectedCode = {
      editor,
      range,
      code,
      version: document.version,
      languageId: document.languageId,
      location: selectionLocation(document, range),
    };
    this.selection = selection;
    this.view.setState({ enabled: true, status: 'waiting', location: selection.location, text: '等待选区稳定…' });
    this.timer = setTimeout(() => void this.explain(selection), selectionDelay);
  }

  private async explain(selection: SelectedCode, retry = false): Promise<void> {
    if (!this.isCurrentSelection(selection)) {
      return;
    }

    this.cancelWork();
    const request = new vscode.CancellationTokenSource();
    this.request = request;
    const isCurrent = () => this.request === request && this.isCurrentSelection(selection);
    const { code, languageId, location } = selection;
    this.view.setState({ enabled: true, status: 'loading', location, text: '' });
    void this.revealView();

    let explanation = '';
    try {
      const projectContext = await collectProjectContext(selection.editor.document, selection.range, request.token);
      if (!isCurrent()) {
        return;
      }
      await this.model.explain({ code, languageId, projectContext, showVariables: this.showVariables }, request.token, (text) => {
        if (isCurrent()) {
          explanation = text;
          this.view.setState({ enabled: true, status: 'loading', location, text });
        }
      }, retry);
      if (isCurrent()) {
        this.view.setState({ enabled: true, status: 'success', location, text: explanation.trim() });
      }
    } catch (error) {
      if (isCurrent()) {
        const text = error instanceof ModelSetupError ? error.message : '暂时无法生成解释，请重试。';
        this.view.setState({ enabled: true, status: 'error', location, text, canRetry: true });
      }
    } finally {
      if (this.request === request) {
        this.request = undefined;
      }
      request.dispose();
    }
  }

  private isCurrentSelection(selection: SelectedCode): boolean {
    const { editor, version, range } = selection;
    return this.enabled && this.selection === selection && vscode.window.activeTextEditor === editor &&
      editor.document.version === version && editor.selections.length === 1 && editor.selection.isEqual(range);
  }

  private clearSelection(): void {
    this.cancelWork();
    this.selection = undefined;
    this.showIdle();
  }

  private cancelWork(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const previousRequest = this.request;
    this.request = undefined;
    previousRequest?.cancel();
  }

  private showIdle(text = this.enabled ? '选中一行或一段代码即可查看解释。' : '启用自动解释后，选中一行或一段代码即可查看解释。'): void {
    this.view.setState({ enabled: this.enabled, status: 'idle', text });
  }

  private updateStatus(): void {
    this.status.text = this.enabled ? '$(book) 解释已开启' : '$(book) 解释已暂停';
    this.status.tooltip = this.enabled ? '暂停自动代码解释' : '开启自动代码解释';
  }

  private async revealView(): Promise<void> {
    if (this.revealedView) {
      return;
    }
    this.revealedView = true;
    try {
      await vscode.commands.executeCommand(`${viewId}.open`, { preserveFocus: true });
    } catch {
      this.revealedView = false;
    }
  }
}

function selectionLocation(document: vscode.TextDocument, range: vscode.Range): string {
  const first = range.start.line + 1;
  const endsAtNextLine = range.end.character === 0 && range.end.line > range.start.line;
  const last = endsAtNextLine ? range.end.line : range.end.line + 1;
  const lines = first === last ? `第 ${first} 行` : `第 ${first}–${last} 行`;
  return `${basename(document.fileName)} · ${lines}`;
}
