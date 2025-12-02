import * as vscode from 'vscode';
import { MakefileInfo } from './types';
import { MakefileParser } from './makefileParser';

export class MakefileDiscovery {
  private parser: MakefileParser;
  private cachedMakefiles: Map<string, MakefileInfo> = new Map();
  private _onMakefilesChanged = new vscode.EventEmitter<void>();
  readonly onMakefilesChanged = this._onMakefilesChanged.event;

  constructor() {
    this.parser = new MakefileParser();
    this.setupFileWatcher();
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

  /**
   * Discover all Makefiles in the workspace
   */
  async discoverMakefiles(): Promise<MakefileInfo[]> {
    const config = vscode.workspace.getConfiguration('makeRunnerPro');
    const patterns = config.get<string[]>('filePatterns', [
      '**/[Mm]akefile',
      '**/*.mk',
      '**/GNUmakefile',
    ]);
    const excludePatterns = config.get<string[]>('excludePatterns', [
      '**/node_modules/**',
      '**/vendor/**',
      '**/.git/**',
    ]);

    const makefiles: MakefileInfo[] = [];
    const foundUris = new Set<string>();

    for (const pattern of patterns) {
      try {
        // Create exclude pattern string for findFiles
        const excludeGlob = `{${excludePatterns.join(',')}}`;
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
    this._onMakefilesChanged.dispose();
  }
}



