import * as vscode from 'vscode';

export interface MakeTarget {
  name: string;
  line: number;
  description?: string;
  dependencies: string[];
  requiredVariables: VariableInfo[];
  isPhony: boolean;
}

export interface VariableInfo {
  name: string;
  defaultValue?: string;
  description?: string;
  line: number;
}

export interface MakefileInfo {
  uri: vscode.Uri;
  relativePath: string;
  targets: MakeTarget[];
  variables: VariableInfo[];
}

export interface VariablePromptResult {
  [key: string]: string;
}

/**
 * Tracks which variables are selected for prompting per target
 * Key format: "makefilePath::targetName::varName"
 */
export interface VariableSelectionState {
  [key: string]: boolean;
}

/**
 * Stores preset values for variables per target
 * Key format: "makefilePath::targetName::varName"
 */
export interface VariablePresetValues {
  [key: string]: string;
}



