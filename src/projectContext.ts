import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import * as vscode from 'vscode';

const maximumContextCharacters = 18_000;
const maximumCurrentFileCharacters = 9_000;
const maximumRelatedFiles = 2;
const maximumRelatedFileCharacters = 4_500;
const maximumDefinitionLookups = 12;
const definitionDeadline = 750;

interface RelatedTarget {
  uri: vscode.Uri;
  range?: vscode.Range;
  importedNames?: string[];
}

/**
 * Collect a small, local slice of the project around the selected code.
 *
 * The collector deliberately follows definitions and explicitly named Python
 * imports only. It does not enumerate a workspace or inspect settings and
 * configuration files, which keeps automatic requests bounded and local.
 */
export async function collectProjectContext(
  document: vscode.TextDocument,
  selection: vscode.Range,
  token: vscode.CancellationToken,
): Promise<string> {
  if (token.isCancellationRequested) {
    return '';
  }

  const parts: string[] = [];
  const currentName = displayPath(document.uri);
  const currentText = buildCurrentFileContext(document, selection);
  parts.push(`当前文件：${currentName}\n${currentText}`);

  const related = await collectRelatedFiles(document, selection, token);
  if (token.isCancellationRequested) {
    return '';
  }

  for (const item of related) {
    if (parts.join('\n\n').length + item.length > maximumContextCharacters) {
      break;
    }
    parts.push(item);
  }

  return parts.join('\n\n').slice(0, maximumContextCharacters);
}

function buildCurrentFileContext(document: vscode.TextDocument, selection: vscode.Range): string {
  const text = document.getText();
  if (text.length <= maximumCurrentFileCharacters) {
    return addLineNumbers(text, 0);
  }

  const startLine = Math.max(0, selection.start.line - 28);
  const endLine = Math.min(document.lineCount - 1, selection.end.line + 28);
  const nearSelection = lines(document, startLine, endLine);
  const imports = text.split(/\r?\n/)
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => isImportLine(line))
    .slice(0, 80)
    .map(({ line, index }) => `${index + 1}: ${line}`)
    .join('\n').slice(0, 2_000);

  const selectedLabel = `${selection.start.line + 1}-${Math.max(selection.start.line + 1, selection.end.line + 1)}`;
  return [
    `[文件较长，保留导入和选区附近内容。选区行：${selectedLabel}]`,
    imports ? `导入：\n${imports}` : '',
    `选区附近：\n${nearSelection}`,
  ].filter(Boolean).join('\n\n').slice(0, maximumCurrentFileCharacters);
}

async function collectRelatedFiles(
  document: vscode.TextDocument,
  selection: vscode.Range,
  token: vscode.CancellationToken,
): Promise<string[]> {
  const targets = new Map<string, RelatedTarget>();
  const positions = identifierPositions(document, selection).slice(0, maximumDefinitionLookups);
  const deadline = Date.now() + definitionDeadline;

  for (const position of positions) {
    if (token.isCancellationRequested) {
      return [];
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const definitions = await Promise.race([
        vscode.commands.executeCommand<unknown>('vscode.executeDefinitionProvider', document.uri, position),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, remaining); }),
      ]);
      for (const definition of normalizeDefinitions(definitions)) {
        if (!isAllowedTarget(document, definition.uri) || definition.uri.toString() === document.uri.toString()) {
          continue;
        }
        const key = definition.uri.toString();
        if (!targets.has(key)) {
          targets.set(key, definition);
        }
        if (targets.size >= maximumRelatedFiles) {
          break;
        }
      }
    } catch {
      // A missing language server should not prevent the current file from
      // being explained.
    } finally {
      clearTimeout(timer);
    }
    if (targets.size >= maximumRelatedFiles) {
      break;
    }
  }

  if (isPython(document)) {
    await addPythonImportTargets(document, selection, targets, token);
  }

  const result: string[] = [];
  for (const target of targets.values()) {
    if (token.isCancellationRequested || result.length >= maximumRelatedFiles) {
      break;
    }
    const item = await readRelatedFile(target, document, token);
    if (item) {
      result.push(item);
    }
  }
  return result;
}

async function addPythonImportTargets(
  document: vscode.TextDocument,
  selection: vscode.Range,
  targets: Map<string, RelatedTarget>,
  token: vscode.CancellationToken,
): Promise<void> {
  if (token.isCancellationRequested || targets.size >= maximumRelatedFiles) {
    return;
  }

  const bases = allowedPythonBases(document);
  const identifiers = new Set(document.getText(selection).match(/[A-Za-z_]\w*/g));
  const imports = parsePythonImports(document.getText());
  const referenced = (item: typeof imports[number]) => item.names.some((name) => identifiers.has(name));
  imports.sort((a, b) => Number(referenced(b)) - Number(referenced(a)));
  for (const { moduleName, names } of imports.slice(0, 40)) {
    if (token.isCancellationRequested || targets.size >= maximumRelatedFiles) {
      return;
    }
    const parts = moduleName.split('.').filter(Boolean);
    if (parts.length === 0 || parts.some((part) => !/^[_A-Za-z][_A-Za-z0-9]*$/.test(part))) {
      continue;
    }
    for (const base of bases) {
      const modulePath = join(base.fsPath, ...parts);
      const candidates = [
        `${modulePath}.py`,
        join(modulePath, '__init__.py'),
      ];
      for (const filename of candidates) {
        const uri = vscode.Uri.file(filename);
        const key = uri.toString();
        if (!isAllowedTarget(document, uri) || targets.has(key) || key === document.uri.toString()) {
          continue;
        }
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (!(stat.type & vscode.FileType.File)) {
            continue;
          }
        } catch {
          continue;
        }
        targets.set(key, { uri, importedNames: names });
        break;
      }
      if (targets.size >= maximumRelatedFiles) {
        return;
      }
    }
  }
}

async function readRelatedFile(
  { uri, range, importedNames }: RelatedTarget,
  source: vscode.TextDocument,
  token: vscode.CancellationToken,
): Promise<string | undefined> {
  if (token.isCancellationRequested || !isAllowedTarget(source, uri)) {
    return undefined;
  }
  try {
    const root = vscode.workspace.getWorkspaceFolder(source.uri)?.uri.fsPath ?? dirname(source.uri.fsPath);
    const location = relative(await realpath(root), await realpath(uri.fsPath));
    if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location) || token.isCancellationRequested) {
      return undefined;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    if (token.isCancellationRequested) {
      return undefined;
    }
    const line = range?.start.line ?? findImportedDefinition(document, importedNames ?? []);
    const before = lines(document, Math.max(0, line - 5), line - 1).slice(-900);
    const excerpt = [before, lines(document, line, Math.min(document.lineCount - 1, line + 24))]
      .filter(Boolean).join('\n').slice(0, maximumRelatedFileCharacters);
    return `相关文件：${displayPath(uri)}\n${excerpt}`;
  } catch {
    return undefined;
  }
}

function identifierPositions(document: vscode.TextDocument, selection: vscode.Range): vscode.Position[] {
  const text = document.getText(selection);
  const positions: vscode.Position[] = [];
  const expression = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null && positions.length < maximumDefinitionLookups) {
    const offset = document.offsetAt(selection.start) + match.index;
    positions.push(document.positionAt(offset));
  }
  return positions;
}

function normalizeDefinitions(value: unknown): Array<{ uri: vscode.Uri; range: vscode.Range }> {
  if (!Array.isArray(value)) {
    value = value ? [value] : [];
  }
  const result: Array<{ uri: vscode.Uri; range: vscode.Range }> = [];
  for (const item of value as unknown[]) {
    if (isLocation(item)) {
      result.push(item);
    } else if (isDefinitionLink(item)) {
      result.push({ uri: item.targetUri, range: item.targetSelectionRange ?? item.targetRange });
    }
  }
  return result;
}

function isLocation(value: unknown): value is { uri: vscode.Uri; range: vscode.Range } {
  return isObject(value) && value.uri instanceof vscode.Uri && value.range instanceof vscode.Range;
}

function isDefinitionLink(value: unknown): value is {
  targetUri: vscode.Uri;
  targetRange: vscode.Range;
  targetSelectionRange?: vscode.Range;
} {
  return isObject(value) && value.targetUri instanceof vscode.Uri && value.targetRange instanceof vscode.Range;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isAllowedTarget(source: vscode.TextDocument, target: vscode.Uri): boolean {
  if (target.scheme !== 'file' && target.scheme !== 'untitled') {
    return false;
  }
  const sourceFolder = vscode.workspace.getWorkspaceFolder(source.uri);
  const targetFolder = vscode.workspace.getWorkspaceFolder(target);
  if (sourceFolder) {
    return targetFolder?.uri.toString() === sourceFolder.uri.toString();
  }
  return dirname(target.fsPath).toLowerCase() === dirname(source.uri.fsPath).toLowerCase();
}

function allowedPythonBases(document: vscode.TextDocument): vscode.Uri[] {
  const bases: vscode.Uri[] = [];
  const currentDirectory = vscode.Uri.file(dirname(document.uri.fsPath));
  bases.push(currentDirectory);
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder && folder.uri.toString() !== currentDirectory.toString()) {
    bases.push(folder.uri);
  }
  return bases;
}

function parsePythonImports(text: string): Array<{ moduleName: string; names: string[] }> {
  const modules = new Map<string, Set<string>>();
  for (const line of text.split(/\r?\n/)) {
    const from = /^\s*from\s+\.?([A-Za-z_][\w.]*)\s+import\s+([^#]+)/.exec(line);
    const imported = /^\s*import\s+([A-Za-z_][\w.]*)(?:\s+as\s+(\w+))?/.exec(line);
    const moduleName = from?.[1] ?? imported?.[1];
    if (!moduleName) {
      continue;
    }
    const names = modules.get(moduleName) ?? new Set<string>();
    names.add(moduleName.split('.')[0]);
    if (from) {
      for (const name of from[2].match(/[A-Za-z_]\w*/g) ?? []) {
        if (name !== 'as') names.add(name);
      }
    } else if (imported?.[2]) {
      names.add(imported[2]);
    }
    modules.set(moduleName, names);
  }
  return Array.from(modules, ([moduleName, names]) => ({ moduleName, names: [...names] }));
}

function findImportedDefinition(document: vscode.TextDocument, names: string[]): number {
  const definitions = /^(?:async\s+)?(?:def|class)\s+(\w+)/;
  for (let line = 0; line < Math.min(document.lineCount, 4_000); line += 1) {
    const match = definitions.exec(document.lineAt(line).text);
    if (match && names.includes(match[1])) {
      return line;
    }
  }
  return 0;
}

function isPython(document: vscode.TextDocument): boolean {
  return document.languageId === 'python' || extname(document.fileName).toLowerCase() === '.py';
}

function isImportLine(line: string): boolean {
  return /^\s*(import\s|from\s|#\s*include\b|using\s|require\s*\()/.test(line);
}

function lines(document: vscode.TextDocument, start: number, end: number): string {
  const output: string[] = [];
  for (let index = start; index <= end; index += 1) {
    output.push(`${index + 1}: ${document.lineAt(index).text}`);
  }
  return output.join('\n');
}

function addLineNumbers(text: string, startLine: number): string {
  return text.split(/\r?\n/).map((line, index) => `${startLine + index + 1}: ${line}`).join('\n');
}

function displayPath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (folder && uri.scheme === 'file') {
    const value = relative(folder.uri.fsPath, uri.fsPath).split(sep).join('/');
    if (value && !value.startsWith('../') && value !== '..') {
      return value;
    }
  }
  return basename(uri.path || uri.fsPath || '当前文件');
}
