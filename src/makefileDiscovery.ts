import * as vscode from 'vscode';
import { MakefileInfo } from './types';
import { MakefileParser } from './makefileParser';

export class MakefileDiscovery {
  private parser: MakefileParser;
  private cachedMakefiles: Map<string, MakefileInfo> = new Map();
  private _onMakefilesChanged = new vscode.EventEmitter<void>();
  readonly onMakefilesChanged = this._onMakefilesChanged.event;
  private configWatcher?: vscode.Disposable;

  constructor() {
    this.parser = new MakefileParser();
    this.setupFileWatcher();
    this.setupConfigurationWatcher();
  }

  private setupFileWatcher(): void {
    // Watch for makefile changes
    const watcher = vscode.workspace.createFileSystemWatcher('**/*');

    watcher.onDidCreate((uri) => {
      if (this.isMakefile(uri)) {
        this.invalidateCache();
      }
    });

    watcher.onDidDelete((uri) => {
      if (this.isMakefile(uri)) {
        this.invalidateCache();
      }
    });

    watcher.onDidChange((uri) => {
      if (this.isMakefile(uri)) {
        this.cachedMakefiles.delete(uri.toString());
        this._onMakefilesChanged.fire();
      }
    });
  }

  private isMakefile(uri: vscode.Uri): boolean {
    const fileName = uri.fsPath.toLowerCase();
    const baseName = fileName.split('/').pop() || '';
    
    return (
      baseName === 'makefile' ||
      baseName === 'gnumakefile' ||
      fileName.endsWith('.mk')
    );
  }

  private invalidateCache(): void {
    this.cachedMakefiles.clear();
    this._onMakefilesChanged.fire();
  }

  private setupConfigurationWatcher(): void {
    this.configWatcher = vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration('makeRunnerPro.filePatterns') ||
        event.affectsConfiguration('makeRunnerPro.excludePatterns') ||
        event.affectsConfiguration('makeRunnerPro.ignorePatterns')
      ) {
        this.invalidateCache();
      }
    });
  }

  private getDiscoveryPatterns(): string[] {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    return config.get<string[]>('filePatterns', [
      '**/[Mm]akefile',
      '**/*.mk',
      '**/GNUmakefile',
    ]);
  }

  private getIgnorePatterns(): string[] {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const excludePatterns = config.get<string[]>('excludePatterns', [
      '**/node_modules/**',
      '**/vendor/**',
      '**/.git/**',
    ]);
    const ignorePatterns = config.get<string[]>('ignorePatterns', [
      '**/.context/**',
    ]);

    return [...new Set([...excludePatterns, ...ignorePatterns])].filter(Boolean);
  }

  private buildExcludeGlob(patterns: string[]): string | undefined {
    if (patterns.length === 0) {
      return undefined;
    }

    return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
  }

  /**
   * Discover all Makefiles in the workspace
   */
  async discoverMakefiles(): Promise<MakefileInfo[]> {
    const patterns = this.getDiscoveryPatterns();
    const excludePatterns = this.getIgnorePatterns();
    const excludeGlob = this.buildExcludeGlob(excludePatterns);

    const makefiles: MakefileInfo[] = [];
    const foundUris = new Set<string>();

    for (const pattern of patterns) {
      try {
        const uris = await vscode.workspace.findFiles(pattern, excludeGlob);

        for (const uri of uris) {
          const uriString = uri.toString();
          
          if (foundUris.has(uriString)) {
            continue;
          }
          foundUris.add(uriString);

          try {
            // Check cache first
            if (this.cachedMakefiles.has(uriString)) {
              makefiles.push(this.cachedMakefiles.get(uriString)!);
            } else {
              const info = await this.parser.parse(uri);
              this.cachedMakefiles.set(uriString, info);
              makefiles.push(info);
            }
          } catch (e) {
            console.error(`Failed to parse ${uri.fsPath}:`, e);
          }
        }
      } catch (e) {
        console.error(`Failed to search for pattern ${pattern}:`, e);
      }
    }

    // Sort by relative path
    makefiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return makefiles;
  }

  /**
   * Get a specific Makefile info
   */
  async getMakefileInfo(uri: vscode.Uri): Promise<MakefileInfo | undefined> {
    const uriString = uri.toString();
    
    if (this.cachedMakefiles.has(uriString)) {
      return this.cachedMakefiles.get(uriString);
    }

    try {
      const info = await this.parser.parse(uri);
      this.cachedMakefiles.set(uriString, info);
      return info;
    } catch {
      return undefined;
    }
  }

  /**
   * Force refresh of all cached data
   */
  refresh(): void {
    this.invalidateCache();
  }

  dispose(): void {
    this.configWatcher?.dispose();
    this._onMakefilesChanged.dispose();
  }
}


