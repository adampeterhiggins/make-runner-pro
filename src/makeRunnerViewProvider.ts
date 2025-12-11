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
      padding: 0;
    }
    .search-container {
      padding: 8px;
      position: sticky;
      top: 0;
      background: var(--vscode-sideBar-background);
      z-index: 10;
    }
    .search-input {
      width: 100%;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      color: var(--vscode-input-foreground);
      padding: 4px 8px;
      font-size: 13px;
      outline: none;
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .tree {
      padding: 0 0 8px 0;
    }
    .tree-item {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      cursor: pointer;
      user-select: none;
    }
    .tree-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .tree-item.makefile {
      padding-left: 8px;
    }
    .tree-item.target {
      padding-left: 24px;
    }
    .tree-item.variable {
      padding-left: 44px;
    }
    .chevron {
      width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 4px;
      font-size: 10px;
      color: var(--vscode-foreground);
      opacity: 0.7;
    }
    .chevron.expanded {
      transform: rotate(90deg);
    }
    .chevron.hidden {
      visibility: hidden;
    }
    .icon {
      width: 16px;
      height: 16px;
      margin-right: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .description {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
      margin-left: 8px;
    }
    .actions {
      display: none;
      gap: 4px;
    }
    .tree-item:hover .actions {
      display: flex;
    }
    .action-btn {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 4px;
      border-radius: 3px;
      font-size: 12px;
      opacity: 0.7;
    }
    .action-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .empty-message {
      padding: 16px;
      text-align: center;
      color: var(--vscode-descriptionForeground);
    }
    .codicon {
      font-family: codicon;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="search-container">
    <input type="text" class="search-input" id="searchInput" placeholder="Filter targets..." value="${this.escapeHtml(this.filterQuery)}" />
  </div>
  <div class="tree">
    ${this.renderTree(filteredMakefiles)}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const searchInput = document.getElementById('searchInput');
    let debounceTimer;

    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        vscode.postMessage({ type: 'filter', query: e.target.value });
      }, 150);
    });

    document.addEventListener('click', (e) => {
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
        <div class="tree-item makefile" data-type="makefile" data-item='${JSON.stringify({ path: mf.uri.toString() })}'>
          <span class="chevron ${isExpanded ? 'expanded' : ''}">&#9654;</span>
          <span class="icon">&#128196;</span>
          <span class="label">${this.escapeHtml(mf.relativePath)}</span>
          <span class="description">${targetCount} targets</span>
          <div class="actions">
            <button class="action-btn" data-action="open" title="Open Makefile">&#128269;</button>
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
      return `<div class="tree-item target"><span class="label" style="color: var(--vscode-descriptionForeground)">No matching targets</span></div>`;
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
        <div class="tree-item target" data-type="target" data-item='${JSON.stringify(itemData)}'>
          <span class="chevron ${hasVars ? (isExpanded ? 'expanded' : '') : 'hidden'}">&#9654;</span>
          <span class="icon">${hasVars ? '&#9655;' : '&#9654;'}</span>
          <span class="label">${this.escapeHtml(target.name)}</span>
          ${hasVars ? `<span class="description">(${selectedCount}/${target.requiredVariables.length} vars)</span>` : ''}
          ${target.isPhony ? `<span class="description">phony</span>` : ''}
          <div class="actions">
            <button class="action-btn" data-action="run" title="Run">&#9654;</button>
            ${hasVars ? `<button class="action-btn" data-action="runWithArgs" title="Run with args">&#9881;</button>` : ''}
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

      const icon = isSelected ? (hasPreset ? '&#9745;' : '&#9745;') : '&#9744;';

      html += `
        <div class="tree-item variable" data-type="variable" data-item='${JSON.stringify(itemData)}'>
          <span class="chevron hidden">&#9654;</span>
          <span class="icon">${icon}</span>
          <span class="label">${this.escapeHtml(variable.name)}</span>
          ${description ? `<span class="description">${description}</span>` : ''}
          <div class="actions">
            <button class="action-btn" data-action="edit" title="Set value">&#9998;</button>
            ${hasPreset ? `<button class="action-btn" data-action="clear" title="Clear value">&#10005;</button>` : ''}
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
