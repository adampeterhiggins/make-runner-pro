import * as vscode from 'vscode';
import { MakeTarget, VariableInfo, MakefileInfo } from './types';

export class MakefileParser {
  /**
   * Parse a Makefile and extract targets and variables
   */
  async parse(uri: vscode.Uri): Promise<MakefileInfo> {
    const document = await vscode.workspace.openTextDocument(uri);
    const content = document.getText();
    const lines = content.split('\n');

    const targets = this.parseTargets(lines, content);
    const variables = this.parseVariables(lines);
    const phonyTargets = this.parsePhonyTargets(content);

    // Mark phony targets
    for (const target of targets) {
      target.isPhony = phonyTargets.has(target.name);
    }

    // Analyze required variables for each target
    for (const target of targets) {
      target.requiredVariables = this.findRequiredVariables(lines, target, variables);
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativePath = workspaceFolder
      ? vscode.workspace.asRelativePath(uri, false)
      : uri.fsPath;

    return {
      uri,
      relativePath,
      targets,
      variables,
    };
  }

  /**
   * Parse all targets from the Makefile
   */
  private parseTargets(lines: string[], content: string): MakeTarget[] {
    const targets: MakeTarget[] = [];
    
    // Target pattern: name at start of line, followed by colon
    // But not if it's a variable assignment (contains =)
    // And not if the colon is part of a path (e.g., C:\)
    const targetRegex = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:((?!=)[^=]*)$/;
    
    // Also match targets with multiple names
    const multiTargetRegex = /^([a-zA-Z_][a-zA-Z0-9_.\s-]+)\s*:((?!=)[^=]*)$/;

    let previousComment = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      // Capture comments that might be target descriptions
      if (trimmedLine.startsWith('#')) {
        previousComment = trimmedLine.slice(1).trim();
        continue;
      }

      // Skip empty lines
      if (!trimmedLine) {
        previousComment = '';
        continue;
      }

      // Skip variable assignments
      if (trimmedLine.includes('=') && !trimmedLine.includes(':=') && trimmedLine.indexOf('=') < trimmedLine.indexOf(':')) {
        previousComment = '';
        continue;
      }

      // Try to match target
      let match = targetRegex.exec(line);
      if (!match) {
        match = multiTargetRegex.exec(line);
      }

      if (match) {
        const targetNames = match[1].trim().split(/\s+/);
        const dependencies = match[2]
          .trim()
          .split(/\s+/)
          .filter((d) => d.length > 0);

        for (const name of targetNames) {
          // Skip special targets and pattern rules
          if (name.startsWith('.') || name.includes('%') || name.includes('$')) {
            continue;
          }

          targets.push({
            name,
            line: i,
            description: previousComment || undefined,
            dependencies,
            requiredVariables: [],
            isPhony: false,
          });
        }
      }

      previousComment = '';
    }

    return targets;
  }

  /**
   * Parse variable definitions from the Makefile
   */
  private parseVariables(lines: string[]): VariableInfo[] {
    const variables: VariableInfo[] = [];
    
    // Variable patterns:
    // VAR = value (recursive)
    // VAR := value (simple)
    // VAR ?= value (conditional)
    // VAR += value (append)
    const varRegex = /^([A-Z_][A-Z0-9_]*)\s*[:?+]?=\s*(.*)$/i;
    
    let previousComment = '';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (trimmedLine.startsWith('#')) {
        previousComment = trimmedLine.slice(1).trim();
        continue;
      }

      const match = varRegex.exec(line);
      if (match) {
        variables.push({
          name: match[1],
          defaultValue: match[2].trim() || undefined,
          description: previousComment || undefined,
          line: i,
        });
      }

      if (!trimmedLine.startsWith('#')) {
        previousComment = '';
      }
    }

    return variables;
  }

  /**
   * Parse .PHONY declarations
   */
  private parsePhonyTargets(content: string): Set<string> {
    const phonySet = new Set<string>();
    
    // Match .PHONY: target1 target2 ...
    const phonyRegex = /^\.PHONY\s*:\s*(.+)$/gm;
    let match;

    while ((match = phonyRegex.exec(content)) !== null) {
      const targets = match[1].trim().split(/\s+/);
      for (const target of targets) {
        if (target && !target.startsWith('$')) {
          phonySet.add(target);
        }
      }
    }

    return phonySet;
  }

  /**
   * Find variables that are required by a target but not defined in the Makefile
   * or are checked with ifndef/ifdef
   */
  private findRequiredVariables(
    lines: string[],
    target: MakeTarget,
    definedVariables: VariableInfo[]
  ): VariableInfo[] {
    const requiredVars: VariableInfo[] = [];
    const definedVarNames = new Set(definedVariables.map((v) => v.name));
    const foundVars = new Set<string>();

    // Find the recipe lines for this target
    const recipeStart = target.line + 1;
    let recipeEnd = lines.length;

    // Recipe continues until next target or non-tab line (after first recipe line)
    for (let i = recipeStart; i < lines.length; i++) {
      const line = lines[i];
      
      // Empty lines are okay
      if (!line.trim()) {
        continue;
      }

      // Recipe lines start with tab
      if (!line.startsWith('\t') && !line.startsWith(' ')) {
        recipeEnd = i;
        break;
      }
    }

    // Look for variable references in the recipe
    const varRefRegex = /\$[({]([A-Z_][A-Z0-9_]*)[)}]/gi;
    
    // Also look for ifndef/error patterns which indicate required variables
    const ifndefRegex = /^\s*ifndef\s+([A-Z_][A-Z0-9_]*)/gmi;
    const errorVarRegex = /\$\(error\s+([A-Z_][A-Z0-9_]*)\s+is\s+required/gi;

    for (let i = target.line; i < recipeEnd; i++) {
      const line = lines[i];
      
      // Check for ifndef pattern (often used for required vars)
      let match;
      while ((match = ifndefRegex.exec(line)) !== null) {
        const varName = match[1];
        if (!foundVars.has(varName)) {
          foundVars.add(varName);
          requiredVars.push({
            name: varName,
            line: i,
          });
        }
      }
      ifndefRegex.lastIndex = 0;

      // Check for $(error VAR is required) pattern
      while ((match = errorVarRegex.exec(line)) !== null) {
        const varName = match[1];
        if (!foundVars.has(varName)) {
          foundVars.add(varName);
          requiredVars.push({
            name: varName,
            line: i,
          });
        }
      }
      errorVarRegex.lastIndex = 0;
    }

    // Look for undefined variables used in the recipe
    // Make built-in functions to exclude from variable detection
    const makeFunctions = new Set([
      'if', 'or', 'and', 'foreach', 'filter', 'filter-out', 'sort', 'word',
      'wordlist', 'words', 'firstword', 'lastword', 'dir', 'notdir', 'suffix',
      'basename', 'addsuffix', 'addprefix', 'join', 'wildcard', 'realpath',
      'abspath', 'call', 'eval', 'origin', 'flavor', 'value', 'error', 'warning',
      'info', 'shell', 'subst', 'patsubst', 'strip', 'findstring', 'file'
    ]);

    // Automatic variables to exclude
    const autoVars = new Set([
      '@', '<', '^', '+', '?', '*', 'MAKE', 'MAKEFLAGS', 'SHELL', 'CURDIR',
      'MAKEFILE_LIST', 'MAKEOVERRIDES', '.VARIABLES', '.FEATURES', '.INCLUDE_DIRS'
    ]);

    for (let i = recipeStart; i < recipeEnd; i++) {
      const line = lines[i];
      let match;

      while ((match = varRefRegex.exec(line)) !== null) {
        const varName = match[1];
        // Skip make built-in functions, automatic variables, defined vars, and already found vars
        if (
          !makeFunctions.has(varName.toLowerCase()) &&
          !autoVars.has(varName) &&
          !definedVarNames.has(varName) &&
          !foundVars.has(varName)
        ) {
          foundVars.add(varName);
          requiredVars.push({
            name: varName,
            line: i,
          });
        }
      }
      varRefRegex.lastIndex = 0;
    }

    return requiredVars;
  }
}



