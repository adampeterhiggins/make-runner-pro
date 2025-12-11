import * as vscode from 'vscode';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakefileInfo, MakeTarget, VariableInfo, VariableSelectionState, VariablePresetValues } from './types';

export class MakeRunnerViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'makeTargets';

  private _view?: vscode.WebviewView;
  private makefiles: MakefileInfo[] = [];
  private variableSelections: VariableSelectionState = {};
  private variablePresets: VariablePresetValues = {};
  private filterQuery: string = '';
  private expandedMakefiles: Set<string> = new Set();
  private expandedTargets: Set<string> = new Set();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly discovery: MakefileDiscovery
  ) {
    // Listen for makefile changes
    discovery.onMakefilesChanged(() => {
      this.refresh();
    });

    // Load saved selections and presets
    this.loadVariableSelections();
    this.loadVariablePresets();
  }

  public async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    // Initial load
    await this.refresh();

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'filter':
          this.filterQuery = data.query.toLowerCase();
          await this.updateTree();
          break;
        case 'runTarget':
          vscode.commands.executeCommand('makeRunnerPro.runTarget',
            vscode.Uri.parse(data.makefileUri), data.targetName);
          break;
        case 'runTargetWithArgs':
          vscode.commands.executeCommand('makeRunnerPro.runTargetWithArgs',
            vscode.Uri.parse(data.makefileUri), data.targetName);
          break;
        case 'toggleMakefile':
          if (this.expandedMakefiles.has(data.path)) {
            this.expandedMakefiles.delete(data.path);
          } else {
            this.expandedMakefiles.add(data.path);
          }
          await this.updateTree();
          break;
        case 'toggleTarget':
          const key = `${data.makefilePath}::${data.targetName}`;
          if (this.expandedTargets.has(key)) {
            this.expandedTargets.delete(key);
          } else {
            this.expandedTargets.add(key);
          }
          await this.updateTree();
          break;
        case 'toggleVariable':
          await this.toggleVariable(data.makefilePath, data.targetName, data.varName);
          break;
        case 'editVariable':
          await this.editVariableValue(data.makefilePath, data.targetName, data.varName, data.defaultValue);
          break;
        case 'clearVariable':
          await this.clearVariableValue(data.makefilePath, data.targetName, data.varName);
          break;
        case 'openMakefile':
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(data.makefileUri));
          await vscode.window.showTextDocument(doc);
          break;
        case 'refresh':
          await this.refresh();
          break;
      }
    });
  }

  public async refresh(): Promise<void> {
    this.makefiles = await this.discovery.discoverMakefiles();

    // Auto-expand if only one makefile
    if (this.makefiles.length === 1) {
      this.expandedMakefiles.add(this.makefiles[0].uri.toString());
    }

    await this.updateTree();
  }

  private async updateTree(): Promise<void> {
    if (!this._view) return;
    this._view.webview.html = this.getHtmlForWebview();
  }

  private getHtmlForWebview(): string {
    const filteredMakefiles = this.filterQuery
      ? this.makefiles.filter(mf => this.makefileHasMatchingTargets(mf))
      : this.makefiles;

    // Auto-expand when filtering
    if (this.filterQuery) {
      filteredMakefiles.forEach(mf => this.expandedMakefiles.add(mf.uri.toString()));
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      line-height: 22px;
    }
    .search-container {
      padding: 4px 8px 4px 8px;
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      z-index: 10;
    }
    .search-input {
      width: 100%;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      color: var(--vscode-input-foreground);
      padding: 3px 6px;
      font-size: var(--vscode-font-size);
      font-family: var(--vscode-font-family);
      outline: none;
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .tree {
      outline: none;
    }
    .tree-item {
      display: flex;
      align-items: center;
      height: 22px;
      padding-right: 12px;
      cursor: pointer;
      user-select: none;
    }
    .tree-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .indent {
      display: inline-block;
      width: 8px;
      flex-shrink: 0;
    }
    .twistie {
      width: 16px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      color: var(--vscode-foreground);
    }
    .twistie.collapsed::before {
      content: '';
      border: 4px solid transparent;
      border-left-color: var(--vscode-foreground);
      border-left-width: 5px;
      margin-left: 3px;
    }
    .twistie.expanded::before {
      content: '';
      border: 4px solid transparent;
      border-top-color: var(--vscode-foreground);
      border-top-width: 5px;
      margin-top: 3px;
    }
    .twistie.hidden {
      visibility: hidden;
    }
    .icon {
      width: 16px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-right: 6px;
      font-size: 16px;
      color: var(--vscode-symbolIcon-fileForeground, var(--vscode-foreground));
    }
    .icon.target {
      color: var(--vscode-symbolIcon-functionForeground, #b180d7);
    }
    .icon.variable {
      color: var(--vscode-symbolIcon-variableForeground, #75beff);
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .description {
      color: var(--vscode-descriptionForeground);
      margin-left: 6px;
      font-size: 0.9em;
      opacity: 0.8;
      flex-shrink: 0;
    }
    .actions {
      display: none;
      margin-left: 4px;
      flex-shrink: 0;
    }
    .tree-item:hover .actions {
      display: flex;
    }
    .tree-item:hover .description.hide-on-hover {
      display: none;
    }
    .action-btn {
      width: 22px;
      height: 22px;
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 3px;
      font-size: 14px;
    }
    .action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .empty-message {
      padding: 10px 20px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="search-container">
    <input type="text" class="search-input" id="searchInput" placeholder="Filter targets..." value="${this.escapeHtml(this.filterQuery)}" />
  </div>
  <div class="tree" id="tree">
    ${this.renderTree(filteredMakefiles)}
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const tree = document.getElementById('tree');
    let debounceTimer;
    let savedSelection = { start: 0, end: 0 };

    // Save cursor position before filter
    searchInput.addEventListener('input', (e) => {
      savedSelection.start = searchInput.selectionStart;
      savedSelection.end = searchInput.selectionEnd;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        vscode.postMessage({ type: 'filter', query: e.target.value });
      }, 200);
    });

    // Restore focus after tree updates
    const observer = new MutationObserver(() => {
      if (document.activeElement !== searchInput && searchInput.value) {
        searchInput.focus();
        searchInput.setSelectionRange(savedSelection.start, savedSelection.end);
      }
    });
    observer.observe(tree, { childList: true, subtree: true });

    // Handle tree item clicks
    tree.addEventListener('click', (e) => {
      const item = e.target.closest('.tree-item');
      if (!item) return;

      const action = e.target.closest('[data-action]');
      if (action) {
        e.stopPropagation();
        const actionType = action.dataset.action;
        const data = JSON.parse(item.dataset.item || '{}');

        if (actionType === 'run') {
          vscode.postMessage({ type: 'runTarget', ...data });
        } else if (actionType === 'runWithArgs') {
          vscode.postMessage({ type: 'runTargetWithArgs', ...data });
        } else if (actionType === 'open') {
          vscode.postMessage({ type: 'openMakefile', ...data });
        } else if (actionType === 'edit') {
          vscode.postMessage({ type: 'editVariable', ...data });
        } else if (actionType === 'clear') {
          vscode.postMessage({ type: 'clearVariable', ...data });
        }
        return;
      }

      const itemType = item.dataset.type;
      const data = JSON.parse(item.dataset.item || '{}');

      if (itemType === 'makefile') {
        vscode.postMessage({ type: 'toggleMakefile', path: data.path });
      } else if (itemType === 'target') {
        if (data.hasVariables) {
          vscode.postMessage({ type: 'toggleTarget', makefilePath: data.makefilePath, targetName: data.targetName });
        } else {
          vscode.postMessage({ type: 'runTarget', makefileUri: data.makefileUri, targetName: data.targetName });
        }
      } else if (itemType === 'variable') {
        vscode.postMessage({ type: 'toggleVariable', ...data });
      }
    });
  </script>
</body>
</html>`;
  }

  private renderTree(makefiles: MakefileInfo[]): string {
    if (makefiles.length === 0) {
      return `<div class="empty-message">${this.filterQuery ? 'No matching targets' : 'No Makefiles found'}</div>`;
    }

    let html = '';
    for (const mf of makefiles) {
      const isExpanded = this.expandedMakefiles.has(mf.uri.toString());
      const targetCount = mf.targets.length;

      html += `
        <div class="tree-item" data-type="makefile" data-item='${JSON.stringify({ path: mf.uri.toString() })}'>
          <span class="indent"></span>
          <span class="twistie ${isExpanded ? 'expanded' : 'collapsed'}"></span>
          <span class="icon">📄</span>
          <span class="label">${this.escapeHtml(mf.relativePath)}</span>
          <span class="description hide-on-hover">${targetCount} targets</span>
          <div class="actions">
            <button class="action-btn" data-action="open" title="Open Makefile">📂</button>
          </div>
        </div>
      `;

      if (isExpanded) {
        html += this.renderTargets(mf);
      }
    }
    return html;
  }

  private renderTargets(mf: MakefileInfo): string {
    let targets = mf.targets;

    if (this.filterQuery) {
      targets = targets.filter(t => this.targetMatchesFilter(t));
    }

    if (targets.length === 0) {
      return `<div class="tree-item"><span class="indent"></span><span class="indent"></span><span class="indent"></span><span class="label" style="color: var(--vscode-descriptionForeground)">No matching targets</span></div>`;
    }

    // Sort: phony first, then alphabetically
    const phony = targets.filter(t => t.isPhony).sort((a, b) => a.name.localeCompare(b.name));
    const regular = targets.filter(t => !t.isPhony).sort((a, b) => a.name.localeCompare(b.name));
    const sorted = [...phony, ...regular];

    let html = '';
    for (const target of sorted) {
      const hasVars = target.requiredVariables.length > 0;
      const targetKey = `${mf.uri.fsPath}::${target.name}`;
      const isExpanded = this.expandedTargets.has(targetKey);
      const selectedCount = hasVars ? target.requiredVariables.filter(v =>
        this.isVariableSelected(mf.uri.fsPath, target.name, v.name)
      ).length : 0;

      const itemData = {
        makefileUri: mf.uri.toString(),
        makefilePath: mf.uri.fsPath,
        targetName: target.name,
        hasVariables: hasVars
      };

      html += `
        <div class="tree-item" data-type="target" data-item='${JSON.stringify(itemData)}'>
          <span class="indent"></span>
          <span class="indent"></span>
          <span class="twistie ${hasVars ? (isExpanded ? 'expanded' : 'collapsed') : 'hidden'}"></span>
          <span class="icon target">▶</span>
          <span class="label">${this.escapeHtml(target.name)}</span>
          ${hasVars ? `<span class="description hide-on-hover">(${selectedCount}/${target.requiredVariables.length} vars)</span>` : ''}
          <div class="actions">
            <button class="action-btn" data-action="run" title="Run">▶</button>
            ${hasVars ? `<button class="action-btn" data-action="runWithArgs" title="Run with args">⚙</button>` : ''}
          </div>
        </div>
      `;

      if (hasVars && isExpanded) {
        html += this.renderVariables(mf, target);
      }
    }
    return html;
  }

  private renderVariables(mf: MakefileInfo, target: MakeTarget): string {
    let html = '';
    for (const variable of target.requiredVariables) {
      const isSelected = this.isVariableSelected(mf.uri.fsPath, target.name, variable.name);
      const presetValue = this.getVariablePreset(mf.uri.fsPath, target.name, variable.name);
      const hasPreset = presetValue !== undefined && presetValue !== '';

      const itemData = {
        makefilePath: mf.uri.fsPath,
        targetName: target.name,
        varName: variable.name,
        defaultValue: variable.defaultValue || ''
      };

      let description = '';
      if (hasPreset) {
        description = `= "${this.escapeHtml(presetValue || '')}"`;
      } else if (variable.defaultValue) {
        description = `(default: ${this.escapeHtml(variable.defaultValue)})`;
      }

      const icon = isSelected ? '☑' : '☐';

      html += `
        <div class="tree-item" data-type="variable" data-item='${JSON.stringify(itemData)}'>
          <span class="indent"></span>
          <span class="indent"></span>
          <span class="indent"></span>
          <span class="twistie hidden"></span>
          <span class="icon variable">${icon}</span>
          <span class="label">${this.escapeHtml(variable.name)}</span>
          ${description ? `<span class="description hide-on-hover">${description}</span>` : ''}
          <div class="actions">
            <button class="action-btn" data-action="edit" title="Set value">✎</button>
            ${hasPreset ? `<button class="action-btn" data-action="clear" title="Clear value">✕</button>` : ''}
          </div>
        </div>
      `;
    }
    return html;
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  private targetMatchesFilter(target: MakeTarget): boolean {
    if (!this.filterQuery) return true;
    return (
      target.name.toLowerCase().includes(this.filterQuery) ||
      (target.description?.toLowerCase().includes(this.filterQuery) ?? false)
    );
  }

  private makefileHasMatchingTargets(makefile: MakefileInfo): boolean {
    if (!this.filterQuery) return true;
    return makefile.targets.some(t => this.targetMatchesFilter(t));
  }

  // Variable selection methods
  private getVariableKey(makefilePath: string, targetName: string, varName: string): string {
    return `${makefilePath}::${targetName}::${varName}`;
  }

  isVariableSelected(makefilePath: string, targetName: string, varName: string): boolean {
    const key = this.getVariableKey(makefilePath, targetName, varName);
    return this.variableSelections[key] !== false;
  }

  async toggleVariable(makefilePath: string, targetName: string, varName: string): Promise<void> {
    const key = this.getVariableKey(makefilePath, targetName, varName);
    const currentValue = this.variableSelections[key] !== false;
    this.variableSelections[key] = !currentValue;
    await this.saveVariableSelections();
    await this.updateTree();
  }

  getVariablePreset(makefilePath: string, targetName: string, varName: string): string | undefined {
    const key = this.getVariableKey(makefilePath, targetName, varName);
    return this.variablePresets[key];
  }

  async editVariableValue(makefilePath: string, targetName: string, varName: string, defaultValue?: string): Promise<void> {
    const key = this.getVariableKey(makefilePath, targetName, varName);
    const currentValue = this.variablePresets[key] ?? defaultValue ?? '';

    const value = await vscode.window.showInputBox({
      prompt: `Set value for ${varName}`,
      value: currentValue,
      placeHolder: `Value for ${varName}`,
    });

    if (value !== undefined) {
      if (value === '') {
        delete this.variablePresets[key];
      } else {
        this.variablePresets[key] = value;
      }
      await this.saveVariablePresets();
      await this.updateTree();
    }
  }

  async clearVariableValue(makefilePath: string, targetName: string, varName: string): Promise<void> {
    const key = this.getVariableKey(makefilePath, targetName, varName);
    delete this.variablePresets[key];
    await this.saveVariablePresets();
    await this.updateTree();
  }

  getSelectedVariables(makefileUri: vscode.Uri, targetName: string, allVariables: VariableInfo[]): VariableInfo[] {
    return allVariables.filter(v => this.isVariableSelected(makefileUri.fsPath, targetName, v.name));
  }

  getPresetValuesForTarget(makefileUri: vscode.Uri, targetName: string, allVariables: VariableInfo[]): VariablePresetValues {
    const result: VariablePresetValues = {};
    for (const v of allVariables) {
      if (this.isVariableSelected(makefileUri.fsPath, targetName, v.name)) {
        const preset = this.getVariablePreset(makefileUri.fsPath, targetName, v.name);
        if (preset !== undefined && preset !== '') {
          result[v.name] = preset;
        }
      }
    }
    return result;
  }

  private loadVariableSelections(): void {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const selections = config.get<VariableSelectionState>('variableSelections', {});
    this.variableSelections = { ...selections };
  }

  private async saveVariableSelections(): Promise<void> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    await config.update('variableSelections', this.variableSelections, vscode.ConfigurationTarget.Workspace);
  }

  private loadVariablePresets(): void {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const presets = config.get<VariablePresetValues>('variablePresets', {});
    this.variablePresets = { ...presets };
  }

  private async saveVariablePresets(): Promise<void> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    await config.update('variablePresets', this.variablePresets, vscode.ConfigurationTarget.Workspace);
  }

  dispose(): void {
    // Cleanup if needed
  }
}
