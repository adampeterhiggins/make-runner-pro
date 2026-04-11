import * as vscode from 'vscode';
import { MakeTarget, VariableInfo, MakefileInfo } from './types';

interface RecursiveMakeInvocation {
  assignedValues: Map<string, string>;
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
        new Map<string, string>(),
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
      assignedValues: new Map<string, string>(),
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
        const variableName = assignmentMatch[1];
        const rawValue = token.slice(assignmentMatch[0].length);
        invocation.assignedValues.set(variableName, rawValue);
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
    inheritedAssignments: Map<string, string>,
    visiting: Set<string>
  ): VariableInfo[] {
    const cacheKey = this.getRequiredVariableCacheKey(target.name, inheritedAssignments);
    if (requiredVariableCache.has(cacheKey)) {
      return [...(requiredVariableCache.get(cacheKey) ?? [])];
    }

    if (visiting.has(cacheKey)) {
      return [];
    }

    visiting.add(cacheKey);
    const directRequiredVariables = this.findDirectRequiredVariables(
      lines,
      target,
      definedVariables,
      inheritedAssignments
    );
    const foundVars = new Set(directRequiredVariables.map((variable) => variable.name));

    const collectFromDependency = (
      dependencyName: string,
      dependencyAssignments: Map<string, string>,
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
      const mergedAssignments = new Map(inheritedAssignments);
      for (const [name, value] of dependencyAssignments) {
        mergedAssignments.set(name, value);
      }

      const dependencyVariables = this.findRequiredVariables(
        lines,
        dependencyTarget,
        definedVariables,
        targetMap,
        explicitDependencies,
        recipeInvocations,
        requiredVariableCache,
        mergedAssignments,
        visiting
      );

      for (const variable of dependencyVariables) {
        if (dependencyAssignments.has(variable.name) || foundVars.has(variable.name)) {
          continue;
        }

        foundVars.add(variable.name);
        directRequiredVariables.push(variable);
      }
    };

    const visited = new Set<string>([target.name]);
    const directDependencies = explicitDependencies.get(target.name) ?? [];
    for (const dependencyName of directDependencies) {
      collectFromDependency(dependencyName, new Map<string, string>(), visited);
    }

    const inferredInvocations = recipeInvocations.get(target.name) ?? [];
    for (const invocation of inferredInvocations) {
      for (const dependencyName of invocation.targetNames) {
        collectFromDependency(dependencyName, invocation.assignedValues, visited);
      }
    }

    visiting.delete(cacheKey);
    requiredVariableCache.set(cacheKey, [...directRequiredVariables]);
    return directRequiredVariables;
  }

  private getRequiredVariableCacheKey(
    targetName: string,
    inheritedAssignments: Map<string, string>
  ): string {
    if (inheritedAssignments.size === 0) {
      return targetName;
    }

    const parts = [...inheritedAssignments.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`);

    return `${targetName}|${parts.join('|')}`;
  }

  private findDirectRequiredVariables(
    lines: string[],
    target: MakeTarget,
    definedVariables: VariableInfo[],
    inheritedAssignments: Map<string, string>
  ): VariableInfo[] {
    const requiredVars: VariableInfo[] = [];
    const foundVars = new Set<string>();
    const definedVariableMap = new Map(definedVariables.map((variable) => [variable.name, variable]));

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
        const assignedValue = inheritedAssignments.get(varName);
        if (!foundVars.has(varName) && !assignedValue) {
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
      const activeVariableNames = this.collectActiveVariableReferences(
        line,
        definedVariableMap,
        inheritedAssignments
      );

      for (const varName of activeVariableNames) {
        if (
          makeFunctions.has(varName.toLowerCase()) ||
          autoVars.has(varName) ||
          foundVars.has(varName)
        ) {
          continue;
        }

        foundVars.add(varName);
        const definedVar = definedVariableMap.get(varName);
        requiredVars.push({
          name: varName,
          defaultValue: definedVar?.defaultValue,
          description: definedVar?.description,
          line: i,
        });
      }
    }

    return requiredVars;
  }

  private collectActiveVariableReferences(
    line: string,
    definedVariables: Map<string, VariableInfo>,
    inheritedAssignments: Map<string, string>
  ): string[] {
    const refs = new Set<string>();
    this.evaluateMakeText(line, definedVariables, inheritedAssignments, refs, 'output');
    return [...refs].filter((name) => !this.isInternalControlVariable(name));
  }

  private isInternalControlVariable(name: string): boolean {
    return name.endsWith('_ACTIONS');
  }

  private evaluateMakeText(
    text: string,
    definedVariables: Map<string, VariableInfo>,
    inheritedAssignments: Map<string, string>,
    refs: Set<string>,
    context: 'output' | 'condition'
  ): string {
    let result = '';

    for (let i = 0; i < text.length; i++) {
      const current = text[i];
      const next = text[i + 1];

      if (current === '$' && (next === '(' || next === '{')) {
        const closing = next === '(' ? ')' : '}';
        const extracted = this.extractMakeExpression(text, i + 2, closing);
        result += this.evaluateMakeExpression(
          extracted.content,
          definedVariables,
          inheritedAssignments,
          refs,
          context
        );
        i = extracted.endIndex;
        continue;
      }

      result += current;
    }

    return result;
  }

  private extractMakeExpression(
    text: string,
    startIndex: number,
    closingChar: ')' | '}'
  ): { content: string; endIndex: number } {
    let depth = 1;
    let content = '';

    for (let i = startIndex; i < text.length; i++) {
      const current = text[i];
      const next = text[i + 1];

      if (current === '$' && (next === '(' || next === '{')) {
        depth += 1;
        content += current;
        continue;
      }

      if (current === closingChar) {
        depth -= 1;
        if (depth === 0) {
          return { content, endIndex: i };
        }
      }

      content += current;
    }

    return { content, endIndex: text.length - 1 };
  }

  private evaluateMakeExpression(
    content: string,
    definedVariables: Map<string, VariableInfo>,
    inheritedAssignments: Map<string, string>,
    refs: Set<string>,
    context: 'output' | 'condition'
  ): string {
    const trimmed = content.trim();
    const functionMatch = /^([A-Za-z][A-Za-z0-9-]*)\s+([\s\S]+)$/.exec(trimmed);
    const makeFunctions = new Set([
      'if', 'or', 'and', 'foreach', 'filter', 'filter-out', 'sort', 'word',
      'wordlist', 'words', 'firstword', 'lastword', 'dir', 'notdir', 'suffix',
      'basename', 'addsuffix', 'addprefix', 'join', 'wildcard', 'realpath',
      'abspath', 'call', 'eval', 'origin', 'flavor', 'value', 'error', 'warning',
      'info', 'shell', 'subst', 'patsubst', 'strip', 'findstring', 'file'
    ]);

    if (functionMatch) {
      const functionName = functionMatch[1];
      const args = this.splitMakeFunctionArgs(functionMatch[2]);

      if (functionName === 'if') {
        const conditionValue = this.evaluateMakeText(
          args[0] ?? '',
          definedVariables,
          inheritedAssignments,
          refs,
          'condition'
        ).trim();
        const selectedBranch = conditionValue ? args[1] ?? '' : args[2] ?? '';
        return this.evaluateMakeText(
          selectedBranch,
          definedVariables,
          inheritedAssignments,
          refs,
          context
        );
      }

      if (functionName === 'filter' || functionName === 'filter-out') {
        const pattern = this.evaluateMakeText(
          args[0] ?? '',
          definedVariables,
          inheritedAssignments,
          refs,
          'condition'
        );
        const text = this.evaluateMakeText(
          args[1] ?? '',
          definedVariables,
          inheritedAssignments,
          refs,
          'condition'
        );
        const patterns = pattern.split(/\s+/).filter(Boolean);
        const words = text.split(/\s+/).filter(Boolean);
        const matches = words.filter((word) => patterns.includes(word));
        const output = functionName === 'filter'
          ? matches
          : words.filter((word) => !patterns.includes(word));
        return output.join(' ');
      }

      if (makeFunctions.has(functionName)) {
        for (const arg of args) {
          this.evaluateMakeText(arg, definedVariables, inheritedAssignments, refs, 'condition');
        }
        return '';
      }
    }

    const variableName = trimmed;
    const definedVariable = definedVariables.get(variableName);
    const assignedValue = inheritedAssignments.get(variableName);

    if (context === 'output' && assignedValue === undefined) {
      refs.add(variableName);
    } else if (
      context === 'condition' &&
      assignedValue === undefined &&
      !this.isInternalControlVariable(variableName)
    ) {
      refs.add(variableName);
    }

    const value = assignedValue ?? definedVariable?.defaultValue ?? '';
    if (context === 'condition' && value.includes('$')) {
      return this.evaluateMakeText(value, definedVariables, inheritedAssignments, refs, 'condition');
    }

    return value;
  }

  private splitMakeFunctionArgs(content: string): string[] {
    const args: string[] = [];
    let current = '';
    let depth = 0;

    for (let i = 0; i < content.length; i++) {
      const char = content[i];
      const next = content[i + 1];

      if (char === '$' && (next === '(' || next === '{')) {
        depth += 1;
        current += char;
        continue;
      }

      if ((char === ')' || char === '}') && depth > 0) {
        depth -= 1;
        current += char;
        continue;
      }

      if (char === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }

      current += char;
    }

    args.push(current.trim());
    return args;
  }
}
