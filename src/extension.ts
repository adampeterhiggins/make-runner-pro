import * as vscode from 'vscode';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakeRunnerViewProvider } from './makeRunnerViewProvider';
import { MakeCodeLensProvider } from './codeLensProvider';
import { TargetRunner } from './targetRunner';
import { MakeTarget } from './types';

let discovery: MakefileDiscovery;
let viewProvider: MakeRunnerViewProvider;
let codeLensProvider: MakeCodeLensProvider;
let targetRunner: TargetRunner;

export function activate(context: vscode.ExtensionContext): void {
  console.log('Make Runner Pro is now active!');

  // Initialize core components
  discovery = new MakefileDiscovery();
  targetRunner = new TargetRunner(discovery);
  viewProvider = new MakeRunnerViewProvider(context.extensionUri, discovery);
  codeLensProvider = new MakeCodeLensProvider(discovery);

  // Connect target runner to view provider for variable selections
  targetRunner.setViewProvider(viewProvider);

  // Register the webview view provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      MakeRunnerViewProvider.viewType,
      viewProvider
    )
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
      async (makefileUri?: vscode.Uri, targetName?: string) => {
        if (makefileUri && targetName) {
          await targetRunner.runTarget(makefileUri, targetName);
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
      async (makefileUri?: vscode.Uri, targetName?: string) => {
        if (makefileUri && targetName) {
          await targetRunner.runTargetWithArgs(makefileUri, targetName);
        } else {
          // Show quick pick to select target
          await showTargetQuickPick(true);
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
      viewProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.toggleVariable',
      async (makefileUri: vscode.Uri, targetName: string, varName: string) => {
        await viewProvider.toggleVariable(makefileUri.fsPath, targetName, varName);
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.editVariableValue',
      async (itemOrUri: any, targetName?: string, varName?: string, defaultValue?: string) => {
        // Handle both context menu invocation (passes tree item) and direct invocation (passes args)
        const uriString: string | undefined = itemOrUri?.makefileUriString;
        const tName: string | undefined = itemOrUri?.targetName;
        const vName: string | undefined = itemOrUri?.variableName;
        const defVal: string | undefined = itemOrUri?.variableDefaultValue;

        if (uriString && tName && vName) {
          const makefilePath = vscode.Uri.parse(uriString).fsPath;
          await viewProvider.editVariableValue(makefilePath, tName, vName, defVal);
        } else if (targetName && varName && typeof itemOrUri === 'string') {
          await viewProvider.editVariableValue(itemOrUri, targetName, varName, defaultValue);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.clearVariableValue',
      async (item: any) => {
        const uriString: string | undefined = item?.makefileUriString;
        const tName: string | undefined = item?.targetName;
        const vName: string | undefined = item?.variableName;

        if (uriString && tName && vName) {
          const makefilePath = vscode.Uri.parse(uriString).fsPath;
          await viewProvider.clearVariableValue(makefilePath, tName, vName);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'makeRunnerPro.openMakefile',
      async (makefileUri: vscode.Uri) => {
        const document = await vscode.workspace.openTextDocument(makefileUri);
        await vscode.window.showTextDocument(document);
      }
    )
  );

  // Add disposables
  context.subscriptions.push({
    dispose: () => {
      discovery.dispose();
      viewProvider.dispose();
      codeLensProvider.dispose();
      targetRunner.dispose();
    },
  });

  // Initial refresh
  viewProvider.refresh();
}

/**
 * Show a quick pick to select a target from all discovered makefiles
 */
async function showTargetQuickPick(forcePrompt: boolean): Promise<void> {
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
    placeHolder: 'Select a Make target to run',
    matchOnDescription: true,
    matchOnDetail: true,
  });

  if (selected) {
    if (forcePrompt) {
      await targetRunner.runTargetWithArgs(selected.makefileUri, selected.targetName);
    } else {
      await targetRunner.runTarget(selected.makefileUri, selected.targetName);
    }
  }
}

export function deactivate(): void {
  // Cleanup is handled by disposables
}



