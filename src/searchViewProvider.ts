import * as vscode from 'vscode';

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  useRegex: boolean;
}

export class SearchViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'makeTargetsSearch';

  private _view?: vscode.WebviewView;
  private _searchOptions: SearchOptions = {
    query: '',
    caseSensitive: false,
    wholeWord: false,
    useRegex: false,
  };

  private _onDidChangeSearch = new vscode.EventEmitter<SearchOptions>();
  public readonly onDidChangeSearch = this._onDidChangeSearch.event;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case 'search':
          this._searchOptions = data.options;
          this._onDidChangeSearch.fire(this._searchOptions);
          break;
      }
    });
  }

  public getSearchOptions(): SearchOptions {
    return this._searchOptions;
  }

  public clearSearch(): void {
    this._searchOptions = {
      query: '',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false,
    };
    this._onDidChangeSearch.fire(this._searchOptions);
    if (this._view) {
      this._view.webview.postMessage({ type: 'clear' });
    }
  }

  private _getHtmlForWebview(_webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      padding: 4px 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .search-input-row {
      display: flex;
      align-items: center;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
    }
    .search-input-row:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    input[type="text"] {
      flex: 1;
      background: transparent;
      border: none;
      color: var(--vscode-input-foreground);
      padding: 4px 8px;
      font-size: 13px;
      outline: none;
      min-width: 0;
    }
    input[type="text"]::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
  </style>
</head>
<body>
  <div class="search-input-row">
    <input type="text" id="searchInput" placeholder="Filter targets..." />
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');

    searchInput.addEventListener('input', (e) => {
      vscode.postMessage({
        type: 'search',
        options: {
          query: e.target.value,
          caseSensitive: false,
          wholeWord: false,
          useRegex: false
        }
      });
    });

    window.addEventListener('message', (event) => {
      if (event.data.type === 'clear') {
        searchInput.value = '';
      }
    });
  </script>
</body>
</html>`;
  }
}
