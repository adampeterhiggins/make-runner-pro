import * as vscode from 'vscode';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakefileInfo, MakeTarget, VariableInfo, VariableSelectionState, VariablePresetValues } from './types';

export type TreeItemType = 'makefile' | 'target' | 'variable';

export class MakeTreeItem extends vscode.TreeItem {
  public readonly itemType: TreeItemType;

  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly makefileInfo?: MakefileInfo,
    public readonly target?: MakeTarget,
    public readonly variable?: VariableInfo,
    public readonly isSelected?: boolean,
    public readonly presetValue?: string
  ) {
    super(label, collapsibleState);

    if (variable && target && makefileInfo) {
      // Variable item (child of target)
      this.itemType = 'variable';

      // Determine icon and description based on selection and preset value
      const hasPreset = presetValue !== undefined && presetValue !== '';

      // Set context value based on whether there's a preset (for context menu visibility)
      this.contextValue = hasPreset ? 'variableWithPreset' : 'variable';
      if (isSelected) {
        this.iconPath = new vscode.ThemeIcon(hasPreset ? 'pass-filled' : 'check');
      } else {
        this.iconPath = new vscode.ThemeIcon('circle-slash');
      }

      // Show preset value or default value in description
      if (hasPreset) {
        this.description = `= "${presetValue}"`;
      } else if (variable.defaultValue) {
        this.description = `(default: ${variable.defaultValue})`;
      } else {
        this.description = '';
      }

      this.tooltip = this.createVariableTooltip(variable, isSelected ?? true, presetValue);

      // Toggle selection on click
      this.command = {
        command: 'makeRunnerPro.toggleVariable',
        title: 'Toggle Variable',
        arguments: [makefileInfo.uri, target.name, variable.name],
      };
    } else if (target && makefileInfo) {
      // Target item
      this.itemType = 'target';
      this.contextValue = 'target';
      this.iconPath = new vscode.ThemeIcon('play');
      this.tooltip = this.createTargetTooltip(target);
      this.description = target.isPhony ? 'phony' : '';

      // Make clicking run the target
      this.command = {
        command: 'makeRunnerPro.runTarget',
        title: 'Run Target',
        arguments: [makefileInfo.uri, target.name],
      };
    } else if (makefileInfo) {
      // Makefile item
      this.itemType = 'makefile';
      this.contextValue = 'makefile';
      this.iconPath = new vscode.ThemeIcon('file-code');
      this.tooltip = makefileInfo.uri.fsPath;
      this.resourceUri = makefileInfo.uri;
      this.description = `${makefileInfo.targets.length} targets`;
    } else {
      this.itemType = 'makefile'; // fallback
    }
  }

  private createVariableTooltip(variable: VariableInfo, isSelected: boolean, presetValue?: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${variable.name}**\n\n`);

    if (variable.description) {
      md.appendMarkdown(`${variable.description}\n\n`);
    }

    if (variable.defaultValue) {
      md.appendMarkdown(`**Default:** \`${variable.defaultValue}\`\n\n`);
    }

    const hasPreset = presetValue !== undefined && presetValue !== '';
    if (hasPreset) {
      md.appendMarkdown(`**Preset Value:** \`${presetValue}\`\n\n`);
      md.appendMarkdown(`**Status:** ${isSelected ? '✓ Will use preset value (no prompt)' : '○ Skipped'}\n\n`);
    } else {
      md.appendMarkdown(`**Status:** ${isSelected ? '✓ Will be prompted' : '○ Skipped'}\n\n`);
    }

    md.appendMarkdown(`_Click to toggle | Right-click to set value_`);

    return md;
  }

  private createTargetTooltip(target: MakeTarget): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${target.name}**\n\n`);

    if (target.description) {
      md.appendMarkdown(`${target.description}\n\n`);
    }

    if (target.dependencies.length > 0) {
      md.appendMarkdown(`**Dependencies:** ${target.dependencies.join(', ')}\n\n`);
    }

    if (target.requiredVariables.length > 0) {
      const varNames = target.requiredVariables.map((v) => `\`${v.name}\``).join(', ');
      md.appendMarkdown(`**Variables:** ${varNames}\n\n`);
    }

    md.appendMarkdown(`_Click to run, or expand to configure variables_`);

    return md;
  }
}

export class MakeTreeViewProvider implements vscode.TreeDataProvider<MakeTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MakeTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private makefiles: MakefileInfo[] = [];
  private variableSelections: VariableSelectionState = {};
  private variablePresets: VariablePresetValues = {};

  constructor(private discovery: MakefileDiscovery) {
    // Listen for makefile changes
    discovery.onMakefilesChanged(() => {
      this.refresh();
    });

    // Load saved variable selections and presets
    this.loadVariableSelections();
    this.loadVariablePresets();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: MakeTreeItem): vscode.TreeItem {
    return element;
  }

  /**
   * Get the selection key for a variable
   */
  private getVariableKey(makefilePath: string, targetName: string, varName: string): string {
    return `${makefilePath}::${targetName}::${varName}`;
  }

  /**
   * Check if a variable is selected (defaults to true)
   */
  isVariableSelected(makefilePath: string, targetName: string, varName: string): boolean {
    const key = this.getVariableKey(makefilePath, targetName, varName);
    return this.variableSelections[key] !== false; // Default to true
  }

  /**
   * Toggle variable selection
   */
  async toggleVariable(makefileUri: vscode.Uri, targetName: string, varName: string): Promise<void> {
    const key = this.getVariableKey(makefileUri.fsPath, targetName, varName);
    const currentValue = this.variableSelections[key] !== false;
    this.variableSelections[key] = !currentValue;

    await this.saveVariableSelections();
    this.refresh();
  }

  /**
   * Get selected variables for a target
   */
  getSelectedVariables(makefileUri: vscode.Uri, targetName: string, allVariables: VariableInfo[]): VariableInfo[] {
    return allVariables.filter(v =>
      this.isVariableSelected(makefileUri.fsPath, targetName, v.name)
    );
  }

  /**
   * Load variable selections from workspace config
   */
  private loadVariableSelections(): void {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    this.variableSelections = config.get<VariableSelectionState>('variableSelections', {});
  }

  /**
   * Save variable selections to workspace config
   */
  private async saveVariableSelections(): Promise<void> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    await config.update('variableSelections', this.variableSelections, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * Load variable presets from workspace config
   */
  private loadVariablePresets(): void {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    this.variablePresets = config.get<VariablePresetValues>('variablePresets', {});
  }

  /**
   * Save variable presets to workspace config
   */
  private async saveVariablePresets(): Promise<void> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    await config.update('variablePresets', this.variablePresets, vscode.ConfigurationTarget.Workspace);
  }

  /**
   * Get preset value for a variable
   */
  getVariablePreset(makefilePath: string, targetName: string, varName: string): string | undefined {
    const key = this.getVariableKey(makefilePath, targetName, varName);
    return this.variablePresets[key];
  }

  /**
   * Set preset value for a variable
   */
  async setVariablePreset(makefileUri: vscode.Uri, targetName: string, varName: string, value: string): Promise<void> {
    const key = this.getVariableKey(makefileUri.fsPath, targetName, varName);
    if (value === '') {
      delete this.variablePresets[key];
    } else {
      this.variablePresets[key] = value;
    }

    await this.saveVariablePresets();
    this.refresh();
  }

  /**
   * Prompt user to set a variable value
   */
  async editVariableValue(makefileUri: vscode.Uri, targetName: string, varName: string, defaultValue?: string): Promise<void> {
    const key = this.getVariableKey(makefileUri.fsPath, targetName, varName);
    const currentValue = this.variablePresets[key] ?? defaultValue ?? '';

    const value = await vscode.window.showInputBox({
      prompt: `Set value for ${varName} (leave empty to clear and prompt at runtime)`,
      value: currentValue,
      placeHolder: `Value for ${varName}`,
      title: `${targetName}: ${varName}`,
    });

    if (value !== undefined) {
      await this.setVariablePreset(makefileUri, targetName, varName, value);
    }
  }

  /**
   * Clear preset value for a variable
   */
  async clearVariableValue(makefileUri: vscode.Uri, targetName: string, varName: string): Promise<void> {
    await this.setVariablePreset(makefileUri, targetName, varName, '');
  }

  /**
   * Get all preset values for selected variables of a target
   */
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

  async getChildren(element?: MakeTreeItem): Promise<MakeTreeItem[]> {
    if (!element) {
      // Root level - show all makefiles
      this.makefiles = await this.discovery.discoverMakefiles();

      if (this.makefiles.length === 0) {
        return [
          new MakeTreeItem(
            'No Makefiles found',
            vscode.TreeItemCollapsibleState.None
          ),
        ];
      }

      // If only one makefile, expand it by default
      const collapsedState =
        this.makefiles.length === 1
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;

      return this.makefiles.map(
        (mf) =>
          new MakeTreeItem(mf.relativePath, collapsedState, mf)
      );
    }

    // Show variables for a target
    if (element.target && element.makefileInfo) {
      const variables = element.target.requiredVariables;

      return variables.map((variable) => {
        const isSelected = this.isVariableSelected(
          element.makefileInfo!.uri.fsPath,
          element.target!.name,
          variable.name
        );
        const presetValue = this.getVariablePreset(
          element.makefileInfo!.uri.fsPath,
          element.target!.name,
          variable.name
        );

        return new MakeTreeItem(
          variable.name,
          vscode.TreeItemCollapsibleState.None,
          element.makefileInfo,
          element.target,
          variable,
          isSelected,
          presetValue
        );
      });
    }

    // Show targets for a makefile
    if (element.makefileInfo && !element.target) {
      const targets = element.makefileInfo.targets;

      if (targets.length === 0) {
        return [
          new MakeTreeItem(
            'No targets found',
            vscode.TreeItemCollapsibleState.None
          ),
        ];
      }

      // Group targets: phony first, then regular, sorted alphabetically
      const phonyTargets = targets.filter((t) => t.isPhony);
      const regularTargets = targets.filter((t) => !t.isPhony);

      phonyTargets.sort((a, b) => a.name.localeCompare(b.name));
      regularTargets.sort((a, b) => a.name.localeCompare(b.name));

      return [...phonyTargets, ...regularTargets].map((target) => {
        // Make targets with variables expandable
        const hasVariables = target.requiredVariables.length > 0;
        const collapsibleState = hasVariables
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;

        const item = new MakeTreeItem(
          target.name,
          collapsibleState,
          element.makefileInfo,
          target
        );

        // Add indicator for targets with variables
        if (hasVariables) {
          const selectedCount = target.requiredVariables.filter(v =>
            this.isVariableSelected(element.makefileInfo!.uri.fsPath, target.name, v.name)
          ).length;
          item.iconPath = new vscode.ThemeIcon('play-circle');
          item.description = `(${selectedCount}/${target.requiredVariables.length} vars)`;
        }

        return item;
      });
    }

    return [];
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}



