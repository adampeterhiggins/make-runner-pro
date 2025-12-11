import * as vscode from 'vscode';
import * as path from 'path';
import { MakefileDiscovery } from './makefileDiscovery';
import { MakeTarget, VariableInfo, VariablePromptResult } from './types';
import { MakeRunnerViewProvider } from './makeRunnerViewProvider';

export class TargetRunner {
  private terminals: vscode.Terminal[] = [];
  private terminalCounter = 0;
  private viewProvider?: MakeRunnerViewProvider;

  constructor(private discovery: MakefileDiscovery) {
    // Clean up terminals when they're closed
    vscode.window.onDidCloseTerminal((terminal) => {
      const index = this.terminals.indexOf(terminal);
      if (index !== -1) {
        this.terminals.splice(index, 1);
      }
    });
  }

  /**
   * Set the view provider to access variable selections
   */
  setViewProvider(provider: MakeRunnerViewProvider): void {
    this.viewProvider = provider;
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

    // Get only the selected variables from the view provider
    const selectedVariables = this.viewProvider
      ? this.viewProvider.getSelectedVariables(makefileUri, targetName, target.requiredVariables)
      : target.requiredVariables;

    // Get preset values for variables (these won't need prompting)
    const presetValues = this.viewProvider
      ? this.viewProvider.getPresetValuesForTarget(makefileUri, targetName, target.requiredVariables)
      : {};

    // Start with preset values
    variables = { ...presetValues };

    // Filter out variables that already have preset values
    const variablesToPrompt = selectedVariables.filter(v => !(v.name in presetValues));

    // Check if we need to prompt for remaining variables
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const autoPrompt = config.get<boolean>('autoPromptVariables', true);

    if ((autoPrompt || forcePrompt) && variablesToPrompt.length > 0) {
      const result = await this.promptForVariables(target, variablesToPrompt);
      if (result === undefined) {
        // User cancelled
        return;
      }
      // Merge prompted values with preset values
      variables = { ...variables, ...result };
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
  private async promptForVariables(
    target: MakeTarget,
    variablesToPrompt?: VariableInfo[]
  ): Promise<VariablePromptResult | undefined> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const savedVariables = config.get<Record<string, string>>('savedVariables', {});

    const variables: VariablePromptResult = {};
    const varsToUse = variablesToPrompt ?? target.requiredVariables;

    for (const varInfo of varsToUse) {
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

    // Get the workspace folder for this makefile
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(makefileUri);
    const workspaceRoot = workspaceFolder?.uri.fsPath;

    // Get the makefile path relative to workspace, or absolute if no workspace
    const makefilePath = workspaceRoot
      ? vscode.workspace.asRelativePath(makefileUri, false)
      : makefileUri.fsPath;

    // Build the command
    const cmdParts: string[] = [makeExecutable];

    // Always use -f with the makefile path (relative to workspace root)
    cmdParts.push('-f', makefilePath);

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

    // Create a new terminal for this run
    const terminal = this.createTerminal(makefileUri, targetName);
    terminal.show();

    // Run from the workspace root directory
    if (workspaceRoot) {
      terminal.sendText(`cd "${workspaceRoot}" && ${command}`);
    } else {
      terminal.sendText(command);
    }
  }

  /**
   * Create a new terminal for running a make target
   */
  private createTerminal(makefileUri: vscode.Uri, targetName: string): vscode.Terminal {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(makefileUri);
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(makefileUri, false)
      : path.basename(makefileUri.fsPath);

    // Use workspace root as the terminal's working directory
    const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(makefileUri.fsPath);

    // Increment counter for unique terminal names
    this.terminalCounter++;

    const terminal = vscode.window.createTerminal({
      name: `Make #${this.terminalCounter}: ${targetName}`,
      cwd,
    });

    this.terminals.push(terminal);
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
    for (const terminal of this.terminals) {
      terminal.dispose();
    }
    this.terminals = [];
  }
}



