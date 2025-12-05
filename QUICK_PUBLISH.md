# Quick Publish Reference

## Pre-Publish Checklist

- [ ] All tests pass: `bun test`
- [ ] Build succeeds: `bun run build`
- [ ] Version numbers updated in all packages
- [ ] Changes committed to git
- [ ] Logged in to npm: `npm login`

## Publish Commands

```bash
# Publish everything (recommended)
bun run publish:all

# Or publish individually in order
bun run publish:core
bun run publish:mcp-server
bun run publish:local
```

## After Publishing

```bash
# Verify packages exist
open https://www.npmjs.com/package/@mnemo/core
open https://www.npmjs.com/package/@mnemo/mcp-server
open https://www.npmjs.com/package/@mnemo/local

# Test global install
npm install -g @mnemo/local
mnemo --help

# Or test with npx
npx @mnemo/local --help
```

## Version Bumping

```bash
# Patch version (0.1.0 → 0.1.1)
cd packages/core && npm version patch
cd packages/mcp-server && npm version patch
cd packages/local && npm version patch

# Minor version (0.1.0 → 0.2.0)
cd packages/core && npm version minor
cd packages/mcp-server && npm version minor
cd packages/local && npm version minor
```

## Troubleshooting

- **"Package not found"**: Make sure you're logged in (`npm login`)
- **Version exists**: Bump version in package.json
- **Build failed**: Run `bun run clean` then `bun run build`

See PUBLISHING.md for complete documentation.
