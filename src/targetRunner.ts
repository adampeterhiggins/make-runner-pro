import * as vscode from 'vscode';
import * as path from 'path';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakeTarget, VariablePromptResult } from './types';

export class TargetRunner {
  private terminals: Map<string, vscode.Terminal> = new Map();

  constructor(private discovery: MakefileDiscovery) {
    // Clean up terminals when they're closed
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [key, term] of this.terminals.entries()) {
        if (term === terminal) {
          this.terminals.delete(key);
          break;
        }
      }
    });
  }

  /**
   * Run a make target, prompting for variables if needed
   */
  async runTarget(
    makefileUri: vscode.Uri,
    targetName: string,
    forcePrompt: boolean = false
  ): Promise<void> {
    const makefileInfo = await this.discovery.getMakefileInfo(makefileUri);
    if (!makefileInfo) {
      vscode.window.showErrorMessage(`Could not parse Makefile: ${makefileUri.fsPath}`);
      return;
    }

    const target = makefileInfo.targets.find((t) => t.name === targetName);
    if (!target) {
      vscode.window.showErrorMessage(`Target '${targetName}' not found in ${makefileUri.fsPath}`);
      return;
    }

    let variables: VariablePromptResult = {};

    // Check if we need to prompt for variables
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const autoPrompt = config.get<boolean>('autoPromptVariables', true);

    if ((autoPrompt || forcePrompt) && target.requiredVariables.length > 0) {
      const result = await this.promptForVariables(target);
      if (result === undefined) {
        // User cancelled
        return;
      }
      variables = result;
    }

    await this.executeTarget(makefileUri, targetName, variables);
  }

  /**
   * Run a target with explicit variable prompts
   */
  async runTargetWithArgs(makefileUri: vscode.Uri, targetName: string): Promise<void> {
    return this.runTarget(makefileUri, targetName, true);
  }

  /**
   * Prompt user for required variable values
   */
  private async promptForVariables(target: MakeTarget): Promise<VariablePromptResult | undefined> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const savedVariables = config.get<Record<string, string>>('savedVariables', {});

    const variables: VariablePromptResult = {};

    for (const varInfo of target.requiredVariables) {
      // Get default value: saved value > defined default > empty
      const defaultValue = savedVariables[varInfo.name] || varInfo.defaultValue || '';

      const prompt = varInfo.description
        ? `${varInfo.name}: ${varInfo.description}`
        : `Enter value for ${varInfo.name}`;

      const value = await vscode.window.showInputBox({
        prompt,
        value: defaultValue,
        placeHolder: `Value for ${varInfo.name}`,
        title: `Make: ${target.name}`,
        ignoreFocusOut: true,
      });

      if (value === undefined) {
        // User cancelled
        return undefined;
      }

      variables[varInfo.name] = value;

      // Save for next time
      savedVariables[varInfo.name] = value;
    }

    // Persist the saved variables
    if (Object.keys(variables).length > 0) {
      await config.update('savedVariables', savedVariables, vscode.ConfigurationTarget.Workspace);
    }

    return variables;
  }

  /**
   * Execute the make command in a terminal
   */
  private async executeTarget(
    makefileUri: vscode.Uri,
    targetName: string,
    variables: VariablePromptResult
  ): Promise<void> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const makeExecutable = config.get<string>('makeExecutable', 'make');
    const extraArgs = config.get<string[]>('extraArguments', []);

    const makefileDir = path.dirname(makefileUri.fsPath);
    const makefileName = path.basename(makefileUri.fsPath);

    // Build the command
    const cmdParts: string[] = [makeExecutable];

    // Add -f flag if not the default Makefile name in cwd
    if (makefileName.toLowerCase() !== 'makefile' && makefileName !== 'GNUmakefile') {
      cmdParts.push('-f', makefileName);
    }

    // Add extra arguments
    cmdParts.push(...extraArgs);

    // Add variable assignments
    for (const [name, value] of Object.entries(variables)) {
      // Escape the value for shell
      const escapedValue = this.shellEscape(value);
      cmdParts.push(`${name}=${escapedValue}`);
    }

    // Add the target
    cmdParts.push(targetName);

    const command = cmdParts.join(' ');

    // Get or create terminal
    const terminal = this.getTerminal(makefileUri);
    terminal.show();

    // Change to the makefile directory and run
    terminal.sendText(`cd "${makefileDir}" && ${command}`);
  }

  /**
   * Get or create a terminal for a makefile
   */
  private getTerminal(makefileUri: vscode.Uri): vscode.Terminal {
    const key = makefileUri.toString();
    
    if (this.terminals.has(key)) {
      const terminal = this.terminals.get(key)!;
      // Check if terminal is still valid
      if (vscode.window.terminals.includes(terminal)) {
        return terminal;
      }
      this.terminals.delete(key);
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(makefileUri);
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(makefileUri, false)
      : path.basename(makefileUri.fsPath);

    const terminal = vscode.window.createTerminal({
      name: `Make: ${relativePath}`,
      cwd: path.dirname(makefileUri.fsPath),
    });

    this.terminals.set(key, terminal);
    return terminal;
  }

  /**
   * Escape a string for safe shell usage
   */
  private shellEscape(str: string): string {
    if (!str) {
      return '""';
    }

    // If the string contains no special characters, return as-is
    if (/^[a-zA-Z0-9_.\-/]+$/.test(str)) {
      return str;
    }

    // Otherwise, wrap in single quotes and escape any single quotes
    return `'${str.replace(/'/g, "'\\''")}'`;
  }

  dispose(): void {
    // Close all terminals
    for (const terminal of this.terminals.values()) {
      terminal.dispose();
    }
    this.terminals.clear();
  }
}



