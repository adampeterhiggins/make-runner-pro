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
      padding: 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
    }
    .search-container {
      display: flex;
      flex-direction: column;
      gap: 4px;
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
    .toggle-buttons {
      display: flex;
      padding-right: 4px;
      gap: 2px;
    }
    .toggle-btn {
      width: 22px;
      height: 22px;
      background: transparent;
      border: 1px solid transparent;
      border-radius: 3px;
      color: var(--vscode-foreground);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 500;
      opacity: 0.6;
    }
    .toggle-btn:hover {
      background: var(--vscode-toolbar-hoverBackground);
      opacity: 1;
    }
    .toggle-btn.active {
      background: var(--vscode-inputOption-activeBackground);
      border-color: var(--vscode-inputOption-activeBorder, transparent);
      color: var(--vscode-inputOption-activeForeground);
      opacity: 1;
    }
    .toggle-btn[title="Use Regular Expression"] {
      font-size: 11px;
    }
  </style>
</head>
<body>
  <div class="search-container">
    <div class="search-input-row">
      <input type="text" id="searchInput" placeholder="Filter targets..." />
      <div class="toggle-buttons">
        <button class="toggle-btn" id="caseSensitive" title="Match Case">Aa</button>
        <button class="toggle-btn" id="wholeWord" title="Match Whole Word">ab</button>
        <button class="toggle-btn" id="useRegex" title="Use Regular Expression">.*</button>
      </div>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    const searchInput = document.getElementById('searchInput');
    const caseSensitiveBtn = document.getElementById('caseSensitive');
    const wholeWordBtn = document.getElementById('wholeWord');
    const useRegexBtn = document.getElementById('useRegex');

    let options = {
      query: '',
      caseSensitive: false,
      wholeWord: false,
      useRegex: false
    };

    function sendSearch() {
      vscode.postMessage({
        type: 'search',
        options: options
      });
    }

    searchInput.addEventListener('input', (e) => {
      options.query = e.target.value;
      sendSearch();
    });

    function toggleButton(btn, key) {
      options[key] = !options[key];
      btn.classList.toggle('active', options[key]);
      sendSearch();
    }

    caseSensitiveBtn.addEventListener('click', () => toggleButton(caseSensitiveBtn, 'caseSensitive'));
    wholeWordBtn.addEventListener('click', () => toggleButton(wholeWordBtn, 'wholeWord'));
    useRegexBtn.addEventListener('click', () => toggleButton(useRegexBtn, 'useRegex'));

    // Handle clear message from extension
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'clear') {
        searchInput.value = '';
        options = {
          query: '',
          caseSensitive: false,
          wholeWord: false,
          useRegex: false
        };
        caseSensitiveBtn.classList.remove('active');
        wholeWordBtn.classList.remove('active');
        useRegexBtn.classList.remove('active');
      }
    });
  </script>
</body>
</html>`;
  }
}
