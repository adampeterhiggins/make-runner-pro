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



