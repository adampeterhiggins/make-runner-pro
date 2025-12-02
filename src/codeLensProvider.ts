import * as vscode from 'vscode';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakeTarget } from './types';

export class MakeCodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(private discovery: MakefileDiscovery) {
    // Refresh code lenses when makefiles change
    discovery.onMakefilesChanged(() => {
      this._onDidChangeCodeLenses.fire();
    });

    // Also refresh when configuration changes
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('makeRunnerPro.showCodeLens')) {
        this._onDidChangeCodeLenses.fire();
      }
    });
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.CodeLens[]> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    if (!config.get<boolean>('showCodeLens', true)) {
      return [];
    }

    // Only provide code lenses for makefiles
    if (!this.isMakefile(document)) {
      return [];
    }

    const codeLenses: vscode.CodeLens[] = [];
    const makefileInfo = await this.discovery.getMakefileInfo(document.uri);

    if (!makefileInfo) {
      return [];
    }

    for (const target of makefileInfo.targets) {
      const range = new vscode.Range(target.line, 0, target.line, target.name.length);
      
      // Run button
      codeLenses.push(
        new vscode.CodeLens(range, {
          title: '▶ Run',
          command: 'makeRunnerPro.runFromCodeLens',
          arguments: [document.uri, target.name, target],
          tooltip: `Run 'make ${target.name}'`,
        })
      );

      // If target has required variables, add a "Run with args" button
      if (target.requiredVariables.length > 0) {
        codeLenses.push(
          new vscode.CodeLens(range, {
            title: '▶ Run with Args',
            command: 'makeRunnerPro.runTargetWithArgs',
            arguments: [document.uri, target.name],
            tooltip: `Run 'make ${target.name}' with variable prompts`,
          })
        );
      }

      // Debug info showing required variables
      if (target.requiredVariables.length > 0) {
        const varNames = target.requiredVariables.map((v) => v.name).join(', ');
        codeLenses.push(
          new vscode.CodeLens(range, {
            title: `$(symbol-variable) ${varNames}`,
            command: '',
            tooltip: `Required variables: ${varNames}`,
          })
        );
      }
    }

    return codeLenses;
  }

  private isMakefile(document: vscode.TextDocument): boolean {
    // Check by language ID
    if (document.languageId === 'makefile') {
      return true;
    }

    // Check by file name
    const fileName = document.fileName.toLowerCase();
    const baseName = fileName.split(/[\\/]/).pop() || '';

    return (
      baseName === 'makefile' ||
      baseName === 'gnumakefile' ||
      fileName.endsWith('.mk')
    );
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose();
  }
}



