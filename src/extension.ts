import * as vscode from 'vscode';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakeTreeItem, MakeTreeViewProvider } from './treeViewProvider';
import { MakeCodeLensProvider } from './codeLensProvider';
import { TargetRunner } from './targetRunner';
import { MakeTarget } from './types';

let discovery: MakefileDiscovery;
let treeViewProvider: MakeTreeViewProvider;
let codeLensProvider: MakeCodeLensProvider;
let targetRunner: TargetRunner;

export function activate(context: vscode.ExtensionContext): void {
  console.log('Make Runner Pro is now active!');

  // Initialize core components
  discovery = new MakefileDiscovery();
  targetRunner = new TargetRunner(discovery);
  treeViewProvider = new MakeTreeViewProvider(discovery);
  codeLensProvider = new MakeCodeLensProvider(discovery);

  // Connect target runner to tree view for variable selections
  targetRunner.setTreeViewProvider(treeViewProvider);

  // Register the tree view
  const treeView = vscode.window.createTreeView('makeTargets', {
    treeDataProvider: treeViewProvider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // Register filter commands
  context.subscriptions.push(
    vscode.commands.registerCommand('makeRunnerPro.filterTargets', async () => {
      const query = await vscode.window.showInputBox({
        prompt: 'Filter Make targets',
        placeHolder: 'Enter search query...',
        value: treeViewProvider.getFilter(),
      });
      if (query !== undefined) {
        treeViewProvider.setFilter(query);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('makeRunnerPro.clearFilter', () => {
      treeViewProvider.clearFilter();
    })
  );

  // Register CodeLens provider for makefiles
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    [
      { language: 'makefile' },
      { pattern: '**/[Mm]akefile' },
      { pattern: '**/*.mk' },
      { pattern: '**/GNUmakefile' },
    ],
    codeLensProvider
  );
  context.subscriptions.push(codeLensDisposable);

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.runTarget',
      async (itemOrUri?: MakeTreeItem | vscode.Uri, targetName?: string) => {
        const targetArgs = getTargetCommandArgs(itemOrUri, targetName);
        if (targetArgs) {
          await targetRunner.runTarget(targetArgs.makefileUri, targetArgs.targetName);
        } else {
          // Show quick pick to select target
          await showTargetQuickPick(false);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.runTargetWithArgs',
      async (itemOrUri?: MakeTreeItem | vscode.Uri, targetName?: string) => {
        const targetArgs = getTargetCommandArgs(itemOrUri, targetName);
        if (targetArgs) {
          await targetRunner.runTargetWithArgs(targetArgs.makefileUri, targetArgs.targetName);
        } else {
          // Show quick pick to select target
          await showTargetQuickPick(true);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.dryRunTarget',
      async (itemOrUri?: MakeTreeItem | vscode.Uri, targetName?: string) => {
        const targetArgs = getTargetCommandArgs(itemOrUri, targetName);
        if (targetArgs) {
          await targetRunner.dryRunTarget(targetArgs.makefileUri, targetArgs.targetName);
        } else {
          // Show quick pick to select target
          await showTargetQuickPick(false, true);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.runFromCodeLens',
      async (makefileUri: vscode.Uri, targetName: string, target: MakeTarget) => {
        // If target has required variables, always prompt
        if (target.requiredVariables.length > 0) {
          await targetRunner.runTargetWithArgs(makefileUri, targetName);
        } else {
          await targetRunner.runTarget(makefileUri, targetName);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('makeRunnerPro.refresh', () => {
      discovery.refresh();
      treeViewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.toggleVariable',
      async (makefileUri: vscode.Uri, targetName: string, varName: string) => {
        await treeViewProvider.toggleVariable(makefileUri, targetName, varName);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.editVariableValue',
      async (itemOrUri: any, targetName?: string, varName?: string, defaultValue?: string) => {
        // Handle both context menu invocation (passes tree item) and direct invocation (passes args)
        // Extract all values to plain strings immediately to avoid any proxy issues
        const uriString: string | undefined = itemOrUri?.makefileUriString;
        const tName: string | undefined = itemOrUri?.targetName;
        const vName: string | undefined = itemOrUri?.variableName;
        const defVal: string | undefined = itemOrUri?.variableDefaultValue;

        if (uriString && tName && vName) {
          // Convert URI string to fsPath
          const makefilePath = vscode.Uri.parse(uriString).fsPath;
          await treeViewProvider.editVariableValue(makefilePath, tName, vName, defVal);
        } else if (targetName && varName && typeof itemOrUri === 'string') {
          await treeViewProvider.editVariableValue(itemOrUri, targetName, varName, defaultValue);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.clearVariableValue',
      async (item: any) => {
        // Extract all values to plain strings immediately to avoid any proxy issues
        const uriString: string | undefined = item?.makefileUriString;
        const tName: string | undefined = item?.targetName;
        const vName: string | undefined = item?.variableName;

        if (uriString && tName && vName) {
          // Convert URI string to fsPath
          const makefilePath = vscode.Uri.parse(uriString).fsPath;
          await treeViewProvider.clearVariableValue(makefilePath, tName, vName);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.openMakefile',
      async (itemOrUri: MakeTreeItem | vscode.Uri) => {
        const makefileUri = getMakefileUri(itemOrUri);
        if (makefileUri) {
          const document = await vscode.workspace.openTextDocument(makefileUri);
          await vscode.window.showTextDocument(document);
        }
      }
    )
  );

  // Add disposables
  context.subscriptions.push({
    dispose: () => {
      discovery.dispose();
      treeViewProvider.dispose();
      codeLensProvider.dispose();
      targetRunner.dispose();
    },
  });

  // Initial refresh
  treeViewProvider.refresh();
}

function getTargetCommandArgs(
  itemOrUri?: MakeTreeItem | vscode.Uri,
  targetName?: string
): { makefileUri: vscode.Uri; targetName: string } | undefined {
  const makefileUri = getMakefileUri(itemOrUri);
  if (makefileUri && targetName) {
    return { makefileUri, targetName };
  }

  if (isTargetTreeItem(itemOrUri)) {
    return {
      makefileUri: vscode.Uri.parse(itemOrUri.makefileUriString),
      targetName: itemOrUri.targetName,
    };
  }

  return undefined;
}

function getMakefileUri(itemOrUri?: MakeTreeItem | vscode.Uri): vscode.Uri | undefined {
  if (itemOrUri instanceof vscode.Uri) {
    return itemOrUri;
  }

  if (hasMakefileUri(itemOrUri)) {
    return vscode.Uri.parse(itemOrUri.makefileUriString);
  }

  return undefined;
}

function isTargetTreeItem(item: MakeTreeItem | vscode.Uri | undefined): item is MakeTreeItem & {
  makefileUriString: string;
  targetName: string;
} {
  const candidate = item as Partial<MakeTreeItem> | undefined;
  return typeof candidate?.makefileUriString === 'string' && typeof candidate.targetName === 'string';
}

function hasMakefileUri(item: MakeTreeItem | vscode.Uri | undefined): item is MakeTreeItem & {
  makefileUriString: string;
} {
  const candidate = item as Partial<MakeTreeItem> | undefined;
  return typeof candidate?.makefileUriString === 'string';
}

/**
 * Show a quick pick to select a target from all discovered makefiles
 */
async function showTargetQuickPick(forcePrompt: boolean, dryRun: boolean = false): Promise<void> {
  const makefiles = await discovery.discoverMakefiles();

  if (makefiles.length === 0) {
    vscode.window.showInformationMessage('No Makefiles found in workspace');
    return;
  }

  interface TargetQuickPickItem extends vscode.QuickPickItem {
    makefileUri: vscode.Uri;
    targetName: string;
  }

  const items: TargetQuickPickItem[] = [];

  for (const mf of makefiles) {
    for (const target of mf.targets) {
      const hasVars = target.requiredVariables.length > 0;
      items.push({
        label: target.name,
        description: mf.relativePath,
        detail: target.description || (hasVars ? `Requires: ${target.requiredVariables.map(v => v.name).join(', ')}` : undefined),
        makefileUri: mf.uri,
        targetName: target.name,
        iconPath: new vscode.ThemeIcon(hasVars ? 'play-circle' : 'play'),
      });
    }
  }

  if (items.length === 0) {
    vscode.window.showInformationMessage('No targets found in any Makefile');
    return;
  }

  const selected = await vscode.window.showQuickPick(items, {
    placeHolder: dryRun ? 'Select a Make target to dry run' : 'Select a Make target to run',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (selected) {
    if (dryRun) {
      await targetRunner.dryRunTarget(selected.makefileUri, selected.targetName);
    } else if (forcePrompt) {
      await targetRunner.runTargetWithArgs(selected.makefileUri, selected.targetName);
    } else {
      await targetRunner.runTarget(selected.makefileUri, selected.targetName);
    }
  }
}

export function deactivate(): void {
  // Cleanup is handled by disposables
}
