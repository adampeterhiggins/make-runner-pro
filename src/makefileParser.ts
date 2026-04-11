import * as vscode from 'vscode';
import { MakeTarget, VariableInfo, MakefileInfo } from './types';

interface RecursiveMakeInvocation {
  assignedVariables: Set<string>;
  targetNames: string[];
}

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
    const explicitDependencies = new Map(
      targets.map((target) => [target.name, [...target.dependencies]])
    );
    const recipeInvocations = this.parseRecursiveMakeInvocations(lines, targets);
    const targetMap = new Map(targets.map((target) => [target.name, target]));
    const requiredVariableCache = new Map<string, VariableInfo[]>();

    // Mark phony targets
    for (const target of targets) {
      target.isPhony = phonyTargets.has(target.name);
    }

    // Merge explicit prerequisites with inferred recursive make dependencies
    for (const target of targets) {
      const invocations = recipeInvocations.get(target.name) ?? [];
      const inferredDependencies = invocations.flatMap((invocation) => invocation.targetNames);
      target.dependencies = [...new Set([...target.dependencies, ...inferredDependencies])];
    }

    // Analyze required variables for each target
    for (const target of targets) {
      target.requiredVariables = this.findRequiredVariables(
        lines,
        target,
        variables,
        targetMap,
        explicitDependencies,
        recipeInvocations,
        requiredVariableCache,
        new Set<string>()
      );
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

  private isTargetDefinition(line: string): boolean {
    const targetRegex = /^([a-zA-Z_][a-zA-Z0-9_.-]*)\s*:((?!=)[^=]*)$/;
    const multiTargetRegex = /^([a-zA-Z_][a-zA-Z0-9_.\s-]+)\s*:((?!=)[^=]*)$/;
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith('#') || line.startsWith('\t') || line.startsWith(' ')) {
      return false;
    }

    if (
      trimmedLine.includes('=') &&
      !trimmedLine.includes(':=') &&
      trimmedLine.indexOf('=') < trimmedLine.indexOf(':')
    ) {
      return false;
    }

    return targetRegex.test(line) || multiTargetRegex.test(line);
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

  private parseRecursiveMakeInvocations(
    lines: string[],
    targets: MakeTarget[]
  ): Map<string, RecursiveMakeInvocation[]> {
    const invocationsByTarget = new Map<string, RecursiveMakeInvocation[]>();

    for (const target of targets) {
      const recipeLines = this.getRecipeRange(lines, target);
      const invocations: RecursiveMakeInvocation[] = [];

      for (let i = recipeLines.start; i < recipeLines.end; i++) {
        const invocation = this.extractRecursiveMakeInvocation(lines[i]);
        if (invocation.targetNames.length > 0) {
          invocations.push(invocation);
        }
      }

      invocationsByTarget.set(target.name, invocations);
    }

    return invocationsByTarget;
  }

  private extractRecursiveMakeInvocation(line: string): RecursiveMakeInvocation {
    const cleanLine = line.trim().replace(/^[@+ -]+/, '').trim();
    const invocation: RecursiveMakeInvocation = {
      assignedVariables: new Set<string>(),
      targetNames: [],
    };

    const commandTokenRegex = /(?:\$\((?:MAKE)\)|\${(?:MAKE)}|make)/i;
    if (!commandTokenRegex.test(cleanLine)) {
      return invocation;
    }

    const tokens = cleanLine.split(/\s+/);
    const makeIndex = tokens.findIndex((token) => /^(?:\$\((?:MAKE)\)|\${(?:MAKE)}|make)$/i.test(token));
    if (makeIndex === -1) {
      return invocation;
    }

    let skipNext = false;

    for (let i = makeIndex + 1; i < tokens.length; i++) {
      const token = tokens[i];

      if (skipNext) {
        skipNext = false;
        continue;
      }

      if (['&&', '||', ';', '|'].includes(token)) {
        break;
      }

      if (/^-[A-Za-z]/.test(token)) {
        if (/^-f$|^--file$|^--makefile$|^--directory$|^-C$/.test(token)) {
          skipNext = true;
        }
        continue;
      }

      const assignmentMatch = /^([A-Za-z_][A-Za-z0-9_]*)[:?+]?=/.exec(token);
      if (assignmentMatch) {
        invocation.assignedVariables.add(assignmentMatch[1]);
        continue;
      }

      if (token.startsWith('$') || token.includes('%') || token.startsWith('.')) {
        continue;
      }

      invocation.targetNames.push(token);
    }

    return invocation;
  }

  private getRecipeRange(lines: string[], target: MakeTarget): { start: number; end: number } {
    const recipeStart = target.line + 1;
    let recipeEnd = lines.length;

    for (let i = recipeStart; i < lines.length; i++) {
      if (this.isTargetDefinition(lines[i])) {
        recipeEnd = i;
        break;
      }
    }

    return { start: recipeStart, end: recipeEnd };
  }

  /**
   * Find variables that are required by a target but not defined in the Makefile
   * or are checked with ifndef/ifdef
   */
  private findRequiredVariables(
    lines: string[],
    target: MakeTarget,
    definedVariables: VariableInfo[],
    targetMap: Map<string, MakeTarget>,
    explicitDependencies: Map<string, string[]>,
    recipeInvocations: Map<string, RecursiveMakeInvocation[]>,
    requiredVariableCache: Map<string, VariableInfo[]>,
    visiting: Set<string>
  ): VariableInfo[] {
    if (requiredVariableCache.has(target.name)) {
      return [...(requiredVariableCache.get(target.name) ?? [])];
    }

    if (visiting.has(target.name)) {
      return [];
    }

    visiting.add(target.name);
    const directRequiredVariables = this.findDirectRequiredVariables(lines, target, definedVariables);
    const foundVars = new Set(directRequiredVariables.map((variable) => variable.name));

    const collectFromDependency = (
      dependencyName: string,
      assignedVariables: Set<string>,
      visited: Set<string>
    ) => {
      if (visited.has(dependencyName)) {
        return;
      }

      const dependencyTarget = targetMap.get(dependencyName);
      if (!dependencyTarget) {
        return;
      }

      visited.add(dependencyName);
      const dependencyVariables = this.findRequiredVariables(
        lines,
        dependencyTarget,
        definedVariables,
        targetMap,
        explicitDependencies,
        recipeInvocations,
        requiredVariableCache,
        visiting
      );

      for (const variable of dependencyVariables) {
        if (assignedVariables.has(variable.name) || foundVars.has(variable.name)) {
          continue;
        }

        foundVars.add(variable.name);
        directRequiredVariables.push(variable);
      }
    };

    const visited = new Set<string>([target.name]);
    const directDependencies = explicitDependencies.get(target.name) ?? [];
    for (const dependencyName of directDependencies) {
      collectFromDependency(dependencyName, new Set<string>(), visited);
    }

    const inferredInvocations = recipeInvocations.get(target.name) ?? [];
    for (const invocation of inferredInvocations) {
      for (const dependencyName of invocation.targetNames) {
        collectFromDependency(dependencyName, invocation.assignedVariables, visited);
      }
    }

    visiting.delete(target.name);
    requiredVariableCache.set(target.name, [...directRequiredVariables]);
    return directRequiredVariables;
  }

  private findDirectRequiredVariables(
    lines: string[],
    target: MakeTarget,
    definedVariables: VariableInfo[]
  ): VariableInfo[] {
    const requiredVars: VariableInfo[] = [];
    const foundVars = new Set<string>();

    const recipeRange = this.getRecipeRange(lines, target);

    // Look for variable references in the recipe
    const varRefRegex = /\$[({]([A-Z_][A-Z0-9_]*)[)}]/gi;
    
    // Also look for ifndef/error patterns which indicate required variables
    const ifndefRegex = /^\s*ifndef\s+([A-Z_][A-Z0-9_]*)/gmi;
    const errorVarRegex = /\$\(error\s+([A-Z_][A-Z0-9_]*)\s+is\s+required/gi;

    for (let i = target.line; i < recipeRange.end; i++) {
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

    for (let i = recipeRange.start; i < recipeRange.end; i++) {
      const line = lines[i];
      let match;

      while ((match = varRefRegex.exec(line)) !== null) {
        const varName = match[1];
        // Skip make built-in functions, automatic variables, and already found vars
        // Note: We include variables defined in the makefile so users can override them
        if (
          !makeFunctions.has(varName.toLowerCase()) &&
          !autoVars.has(varName) &&
          !foundVars.has(varName)
        ) {
          foundVars.add(varName);
          // Include default value if variable is defined in the makefile
          const definedVar = definedVariables.find(v => v.name === varName);
          requiredVars.push({
            name: varName,
            defaultValue: definedVar?.defaultValue,
            description: definedVar?.description,
            line: i,
          });
        }
      }
      varRefRegex.lastIndex = 0;
    }

    return requiredVars;
  }
}
