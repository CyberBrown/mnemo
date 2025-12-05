# NPM Publishing Preparation Summary

This document summarizes the changes made to prepare Mnemo packages for npm publishing.

## Changes Made

### 1. Package Configuration Updates

All three publishable packages (`@mnemo/core`, `@mnemo/mcp-server`, `@mnemo/local`) have been updated with:

#### Added Metadata Fields
- `author`: "Voltage Labs"
- `license`: "MIT"
- `repository`: Links to GitHub repo with proper directory paths
- `homepage`: GitHub README link
- `bugs`: GitHub issues link
- `keywords`: Relevant search terms for npm discovery

#### Build Configuration
- `main`: Points to `./dist/index.js` (compiled output)
- `types`: Points to `./dist/index.d.ts` (TypeScript declarations)
- `exports`: Modern ES module exports configuration
- `files`: Specifies what gets published (`dist`, `src`, `README.md`)
- `engines`: Specifies Node.js >= 18.0.0

#### Build Scripts
- `build`: Uses `bun x tsc --build` for TypeScript compilation
- `clean`: Removes build artifacts
- `prepublishOnly`: Runs clean + build automatically before publishing
- `typecheck`: Type checking without emitting files

#### Publishing Configuration
- `publishConfig.access`: "public" (required for scoped packages)

### 2. CLI Package (`@mnemo/local`)

Special configuration for global CLI installation:

- `bin` field updated to point to compiled files:
  - `mnemo`: `./dist/cli.js`
  - `mnemo-stdio`: `./dist/stdio.js`
- Shebangs (`#!/usr/bin/env bun`) preserved in compiled output
- Can be installed globally or run via `npx`/`bunx`

### 3. Root Package Updates

Added publish scripts to root `package.json`:

```bash
bun run publish:core        # Publish core package
bun run publish:mcp-server  # Publish mcp-server package
bun run publish:local       # Publish local package
bun run publish:all         # Build and publish all packages in order
bun run clean               # Clean all build artifacts
```

### 4. TypeScript Configuration

- Removed `bun-types` from required types to avoid publish issues
- Added `**/*.test.ts` to exclude pattern (test files won't be published)
- Build now generates:
  - JavaScript output (`.js`)
  - TypeScript declarations (`.d.ts`)
  - Source maps (`.js.map`, `.d.ts.map`)

### 5. Code Fixes

Fixed TypeScript compilation issues:

- **gemini-client.ts**: Added type assertion for async iterator
- **source-loader.ts**: Updated pdfjs import (handled by linter)
- **index.ts & stdio.ts**: Added missing 'refresh' operation to UsageOperation record
- **index.ts & stdio.ts**: Added type assertion for SQLite bindings

### 6. Documentation

Created two new documentation files:

- **PUBLISHING.md**: Complete publishing guide with:
  - Pre-publish checklist
  - Version management
  - Publishing workflows (all packages, individual, manual)
  - Post-publish verification
  - Testing procedures
  - Troubleshooting
  - User installation examples

- **PUBLISHING_SUMMARY.md**: This file

## Package Structure

```
@mnemo/core (no internal dependencies)
  ↑
@mnemo/mcp-server (depends on core)
  ↑
@mnemo/local (depends on core + mcp-server)
```

**Important**: Packages must be published in dependency order!

## Files Included in Published Packages

Each package will include:

- `dist/` - Compiled JavaScript and TypeScript declarations
- `src/` - Source TypeScript files (for debugging)
- `README.md` - Package documentation
- `package.json` - Package metadata

Files excluded:

- `node_modules/`
- Test files (`**/*.test.ts`, `**/*.test.js`)
- Build configuration files
- Development-only files

## Pre-Publish Verification

### Build Test
```bash
# Clean and rebuild all packages
bun run clean
bun run build
```

Result: All packages build successfully ✅

### Package Contents Test
```bash
# Check what will be published (dry run)
cd packages/core && npm pack --dry-run
cd packages/mcp-server && npm pack --dry-run
cd packages/local && npm pack --dry-run
```

### CLI Test
```bash
# After building, test CLI locally
packages/local/dist/cli.js --help
```

Expected: Should display help message ✅

## Next Steps

Before actually publishing to npm:

1. **Update version numbers** in all three package.json files
   - Keep versions synchronized
   - Follow semver (0.1.0 → 0.1.1 for patches, 0.2.0 for features)

2. **Create git tags**
   ```bash
   git tag v0.1.0
   git push --tags
   ```

3. **Test with npm pack**
   ```bash
   cd packages/local
   npm pack
   npm install -g ./mnemo-local-0.1.0.tgz
   mnemo --help
   ```

4. **Login to npm**
   ```bash
   npm login
   ```

5. **Publish** (see PUBLISHING.md for detailed instructions)
   ```bash
   bun run publish:all
   ```

6. **Verify on npm**
   - Check package pages: npmjs.com/package/@mnemo/{core,mcp-server,local}
   - Test installation: `npm install -g @mnemo/local`
   - Test CLI: `mnemo --help`

## Installation Methods for Users

After publishing, users can install the CLI via:

```bash
# Global installation (npm)
npm install -g @mnemo/local

# Global installation (Bun)
bun add -g @mnemo/local

# Run without installing (npx)
npx @mnemo/local serve

# Run without installing (bunx)
bunx @mnemo/local serve
```

## Workspace Dependencies

The packages use `workspace:*` for internal dependencies. When publishing:

- npm automatically converts these to specific version ranges
- Ensure published versions of dependencies exist before publishing dependent packages
- This is why publishing order matters: core → mcp-server → local

## Important Notes

1. **First publish only**: The first time you publish, you may need to request access to the `@mnemo` scope on npm

2. **Version immutability**: Once published, a version cannot be changed. Always bump version numbers for new publishes.

3. **Access**: These packages are configured as public. Ensure the `@mnemo` scope allows public packages.

4. **Bun requirement**: The CLI requires Bun runtime. The shebang `#!/usr/bin/env bun` assumes Bun is installed globally.

5. **Node compatibility**: While developed with Bun, the compiled output should work with Node.js ≥18 (though Bun-specific features like `Bun.sqlite` may not work).

## Build Artifacts Summary

### @mnemo/core (dist/ size: ~156KB)
- gemini-client.{js,d.ts,map}
- repo-loader.{js,d.ts,map}
- source-loader.{js,d.ts,map}
- types.{js,d.ts,map}
- index.{js,d.ts,map}

### @mnemo/mcp-server (dist/)
- MCP protocol implementation
- Tool definitions and handlers
- index.{js,d.ts,map}

### @mnemo/local (dist/ size: ~92KB)
- cli.js (with shebang)
- stdio.js (with shebang)
- index.{js,d.ts,map}

## Questions?

See PUBLISHING.md for detailed instructions or contact the maintainers at:
- GitHub Issues: https://github.com/CyberBrown/mnemo/issues
- Repository: https://github.com/CyberBrown/mnemo
