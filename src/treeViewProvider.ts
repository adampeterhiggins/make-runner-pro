import * as vscode from 'vscode';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakefileInfo, MakeTarget } from './types';

export class MakeTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly makefileInfo?: MakefileInfo,
    public readonly target?: MakeTarget
  ) {
    super(label, collapsibleState);

    if (target && makefileInfo) {
      // Target item
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
      this.contextValue = 'makefile';
      this.iconPath = new vscode.ThemeIcon('file-code');
      this.tooltip = makefileInfo.uri.fsPath;
      this.resourceUri = makefileInfo.uri;
      this.description = `${makefileInfo.targets.length} targets`;
    }
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
      md.appendMarkdown(`**Required Variables:** ${varNames}\n\n`);
    }

    md.appendMarkdown(`_Click to run, or right-click for more options_`);
    
    return md;
  }
}

export class MakeTreeViewProvider implements vscode.TreeDataProvider<MakeTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MakeTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private makefiles: MakefileInfo[] = [];

  constructor(private discovery: MakefileDiscovery) {
    // Listen for makefile changes
    discovery.onMakefilesChanged(() => {
      this.refresh();
    });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: MakeTreeItem): vscode.TreeItem {
    return element;
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
        const item = new MakeTreeItem(
          target.name,
          vscode.TreeItemCollapsibleState.None,
          element.makefileInfo,
          target
        );

        // Add indicator for targets with required variables
        if (target.requiredVariables.length > 0) {
          item.iconPath = new vscode.ThemeIcon('play-circle');
          item.description = `(${target.requiredVariables.length} vars)`;
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



