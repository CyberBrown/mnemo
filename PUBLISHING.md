# Publishing Guide

This guide covers how to publish Mnemo packages to npm.

## Package Overview

Mnemo is a monorepo with the following publishable packages:

- `@mnemo/core` - Core functionality (Gemini client, repo loader, types)
- `@mnemo/mcp-server` - MCP protocol implementation
- `@mnemo/local` - Local Bun server with CLI (recommended for users)

Note: `@mnemo/cf-worker` is deployment-specific and not published to npm.

## Prerequisites

1. **npm account**: You need an npm account with publish access to the `@mnemo` scope
2. **Authentication**: Run `npm login` before publishing
3. **Build environment**: Ensure you have Bun and TypeScript installed

## Pre-Publish Checklist

Before publishing, ensure:

- [ ] All tests pass: `bun test`
- [ ] TypeScript compiles: `bun run typecheck`
- [ ] Version numbers are updated in all package.json files
- [ ] CHANGELOG.md is updated (if you maintain one)
- [ ] All changes are committed to git

## Version Management

Update versions in all packages before publishing:

```bash
# Update version in each package.json manually, or use npm version
cd packages/core
npm version patch  # or minor, major

cd ../mcp-server
npm version patch

cd ../local
npm version patch
```

**Important**: Keep version numbers synchronized across all packages.

## Publishing

### Option 1: Publish All Packages (Recommended)

```bash
# From the root directory
bun run publish:all
```

This will:
1. Build all packages
2. Publish `@mnemo/core`
3. Publish `@mnemo/mcp-server` (depends on core)
4. Publish `@mnemo/local` (depends on both)

### Option 2: Publish Individual Packages

If you need to publish packages individually:

```bash
# Publish in dependency order (important!)
bun run publish:core
bun run publish:mcp-server
bun run publish:local
```

### Option 3: Manual Publishing

```bash
# Build all packages first
bun run build

# Then publish each package
cd packages/core
npm publish

cd ../mcp-server
npm publish

cd ../local
npm publish
```

## Post-Publish Verification

After publishing, verify the packages:

```bash
# Check package pages on npm
open https://www.npmjs.com/package/@mnemo/core
open https://www.npmjs.com/package/@mnemo/mcp-server
open https://www.npmjs.com/package/@mnemo/local

# Test global CLI installation
npm install -g @mnemo/local
mnemo --help

# Or test with npx
npx @mnemo/local --help

# Test with bunx
bunx @mnemo/local --help
```

## Testing Before Publishing

To test packages locally before publishing:

```bash
# Build packages
bun run build

# Link packages locally
cd packages/core
npm link

cd ../mcp-server
npm link @mnemo/core
npm link

cd ../local
npm link @mnemo/core
npm link @mnemo/mcp-server
npm link

# Test global CLI
npm link
mnemo --help
```

## Package Dependencies

The packages have the following dependency chain:

```
@mnemo/core (no internal deps)
  ↑
@mnemo/mcp-server (depends on core)
  ↑
@mnemo/local (depends on core + mcp-server)
```

Always publish in this order: core → mcp-server → local

## Workspace Dependencies

The monorepo uses workspace dependencies (`workspace:*`). When publishing:

- npm will automatically convert `workspace:*` to specific version ranges
- Ensure the published version of dependencies exists on npm before publishing dependent packages

## Common Issues

### Issue: "Package not found" during publish
**Solution**: Make sure you're logged in (`npm login`) and have publish access to the `@mnemo` scope.

### Issue: Version already exists
**Solution**: Bump the version number in package.json and try again. npm doesn't allow overwriting published versions.

### Issue: Build artifacts missing
**Solution**: Run `bun run build` before publishing. The `prepublishOnly` hook should handle this automatically.

### Issue: CLI not executable after install
**Solution**: Ensure bin files have proper shebang (`#!/usr/bin/env bun`) and are built to dist/.

## CLI Installation for Users

After publishing, users can install the CLI globally in several ways:

```bash
# Using npm (works with Node.js)
npm install -g @mnemo/local

# Using Bun
bun add -g @mnemo/local

# Using npx (no installation)
npx @mnemo/local serve

# Using bunx (no installation)
bunx @mnemo/local serve
```

## Publishing Beta Versions

For beta/pre-release versions:

```bash
# Update version to include beta tag
cd packages/local
npm version 0.2.0-beta.1

# Publish with beta tag
npm publish --tag beta

# Users install with:
npm install -g @mnemo/local@beta
```

## Rollback

If you need to rollback a published version:

```bash
# Deprecate a version (preferred)
npm deprecate @mnemo/local@0.1.0 "Use version 0.1.1 instead"

# Unpublish (only within 72 hours, discouraged)
npm unpublish @mnemo/local@0.1.0
```

## Automation

For CI/CD automation, you can:

1. Set up npm token: `NPM_TOKEN` environment variable
2. Add to `.npmrc`: `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`
3. Run publish in CI with: `npm publish --access public`

## Files Included in Published Packages

Each package includes:
- `dist/` - Compiled JavaScript and TypeScript declarations
- `src/` - Source TypeScript files (for source maps and debugging)
- `README.md` - Package documentation
- `package.json` - Package metadata

Files excluded:
- `node_modules/`
- `.wrangler/`
- `*.test.ts`
- Development files

## Support

For issues or questions:
- GitHub Issues: https://github.com/CyberBrown/mnemo/issues
- Documentation: https://github.com/CyberBrown/mnemo#readme
