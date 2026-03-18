# Make Runner Pro

A powerful VS Code extension for running Makefile targets with advanced features like variable prompts, CodeLens buttons, and comprehensive file discovery.

## Features

### 🎯 Comprehensive Makefile Discovery

Unlike other extensions, Make Runner Pro discovers:
- Standard `Makefile` and `makefile` files
- `.mk` extension files
- `GNUmakefile` files  
- Makefiles in dot-prefixed folders (e.g., `.github/workflows/Makefile`)

### ▶️ CodeLens Play Buttons

Run targets directly from the Makefile with inline play buttons:

- **▶ Run** - Execute the target immediately
- **▶ Run with Args** - Prompt for variable values before running

### 📋 Sidebar Tree View

Access all your Makefile targets from any file via the dedicated sidebar:

- Organized by Makefile location
- Shows target count and required variables
- One-click execution
- Right-click for additional options

### 🔤 Variable Prompting

When running a target that requires variables (detected via `ifndef`/`$(error ...)` patterns or undefined variable references), you'll be prompted to enter values:

- Values are remembered for convenience
- Supports default values from Makefile definitions
- Can be disabled in settings

## Usage

### Running Targets

1. **From CodeLens**: Click the play button next to any target in a Makefile
2. **From Sidebar**: Click on a target in the Make Runner sidebar
3. **From Command Palette**: Run "Make: Run Target" and select from the list

### Configuration

Configure via VS Code settings:

| Setting | Default | Description |
|---------|---------|-------------|
| `makeRunnerPro.makeExecutable` | `"make"` | Path to the make executable |
| `makeRunnerPro.filePatterns` | See below | Glob patterns for finding Makefiles |
| `makeRunnerPro.excludePatterns` | `["**/node_modules/**", ...]` | Base patterns to exclude |
| `makeRunnerPro.ignorePatterns` | `["**/.context/**"]` | Additional ignore rules you can set in user or workspace settings |
| `makeRunnerPro.showCodeLens` | `true` | Show play buttons in Makefiles |
| `makeRunnerPro.autoPromptVariables` | `true` | Auto-prompt for required variables |
| `makeRunnerPro.extraArguments` | `[]` | Additional args to pass to make |

Default file patterns:
```json
[
  "**/[Mm]akefile",
  "**/*.mk",
  "**/GNUmakefile",
  "**/.*/[Mm]akefile",
  "**/.*/**/*.mk"
]
```

Example user or workspace settings:
```json
{
  "makeRunnerPro.ignorePatterns": [
    "**/.context/**",
    "**/third_party/**",
    "**/vendor/legacy/**"
  ]
}
```

## Variable Detection

The extension detects required variables through several patterns:

1. **ifndef checks**:
   ```makefile
   deploy:
   ifndef DEPLOY_KEY
       $(error DEPLOY_KEY is required)
   endif
       ./deploy.sh
   ```

2. **Error patterns**:
   ```makefile
   upload:
       $(if $(GCS_BUCKET),,$(error GCS_BUCKET is required))
   ```

3. **Undefined variable references**:
   ```makefile
   test:
       ./run-tests.sh --env=$(TEST_ENV)
   ```
   (If `TEST_ENV` is not defined in the Makefile, it will be detected)

## Requirements

- Make must be installed and accessible (configurable via `makeRunnerPro.makeExecutable`)
- VS Code 1.80.0 or higher

## Known Limitations

- Complex variable expansion is not fully analyzed
- Pattern rules (with `%`) are not shown as targets
- Included makefiles are not parsed

## Contributing

Issues and pull requests are welcome!

## Development

For the local Cursor extension workflow:

```bash
make cursor-install
```

That target mirrors the `db-inspector` setup:
- bumps `package.json` and `package-lock.json` if the current version is not ahead of the latest git tag or local VSIX version
- packages the extension into a VSIX
- commits with the version number as the default commit message
- tags the commit as `v<version>`
- reinstalls the VSIX into Cursor and verifies the installed version

Useful flags:
- `YES=1` skips interactive prompts
- `FORCE=1` bypasses the version gate for a forced rebuild/reinstall

## License

MIT
