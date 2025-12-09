# Mnemo Open Source Pre-Release Checklist

## Overview

This checklist covers everything needed before releasing Mnemo as an open-source project. Items are prioritized by importance for launch.

---

## 🔴 High Priority (Required for Launch)

### Documentation

- [ ] **CONTRIBUTING.md** - Essential for any open-source project
  - How to set up development environment
  - Code style guidelines (Bun, TypeScript, project conventions)
  - How to run tests
  - Pull request process
  - Issue templates (bug report, feature request)

- [ ] **Clean up internal files**
  - [ ] Remove or generalize `CLAUDE.md` (internal dev instructions)
  - [ ] Remove or generalize `AGENTS_DEPLOY.md` (internal deployment notes)
  - [ ] Remove or generalize `PARALLEL_TASKS.md` (internal task tracking)
  - [ ] Remove `mnemo.zip` from repository root

- [ ] **Branding consistency**
  - [ ] Decide: Is this a "CyberBrown" project or "Voltage Labs" project?
  - [ ] Update README credits to match
  - [ ] Update package.json author fields
  - [ ] Ensure LICENSE has correct copyright holder

- [ ] **Document capability differences**
  - [ ] Add section to README explaining Local vs Worker capabilities
  - [ ] Local server: can load local filesystem paths + GitHub repos
  - [ ] Worker server: GitHub repos only (no local filesystem access)
  - [ ] Make this clear in CLI help text as well

### Configuration & Setup

- [ ] **Configuration validation**
  - [ ] Clear error message when `GEMINI_API_KEY` is missing
  - [ ] Validate all required environment variables on startup
  - [ ] Document all environment variables in one place (README or separate CONFIG.md)

- [ ] **First-time setup experience**
  - [ ] Test `bun install && bun run dev` from clean clone
  - [ ] Verify all dependencies install correctly
  - [ ] Add troubleshooting section for common setup issues

### Testing & CI

- [ ] **Test coverage**
  - [ ] Verify existing tests pass
  - [ ] Add integration tests for MCP server endpoints
  - [ ] Add tests for CLI commands
  - [ ] Add tests for URL adapter (new feature)

- [ ] **GitHub Actions CI workflow**
  - [ ] Run tests on PR
  - [ ] Run tests on push to main
  - [ ] Lint check
  - [ ] Type check

### New Features (Required)

- [ ] **URL Adapter** - See `URL_ADAPTER_IMPLEMENTATION.md`
  - [ ] HTML extraction (Readability + cheerio fallback)
  - [ ] PDF extraction
  - [ ] JSON extraction
  - [ ] Token-based crawling
  - [ ] robots.txt respect
  - [ ] Rate limiting
  - [ ] Integration with `loadSingleSource`

---

## 🟡 Medium Priority (Recommended for Launch)

### Documentation

- [ ] **API documentation**
  - [ ] Document all MCP tool schemas
  - [ ] Input parameters for each tool
  - [ ] Response formats
  - [ ] Error codes and handling

- [ ] **Examples directory**
  - [ ] Example: Load GitHub repo and query it
  - [ ] Example: Load documentation site
  - [ ] Example: Claude Code MCP integration step-by-step
  - [ ] Example: Load PDF and query it

- [ ] **JSDoc comments**
  - [ ] Add JSDoc to all public interfaces
  - [ ] Add JSDoc to exported functions
  - [ ] Generate API docs from JSDoc (optional)

### Code Quality

- [ ] **Error handling review**
  - [ ] Network failure handling
  - [ ] Gemini API rate limit handling
  - [ ] Cache expiration during session
  - [ ] Invalid input validation

- [ ] **Logging**
  - [ ] Consistent logging format
  - [ ] Debug mode for verbose output
  - [ ] Log levels (error, warn, info, debug)

### Release Management

- [ ] **Versioning**
  - [ ] Set up semantic versioning
  - [ ] Create initial release tag (v0.1.0)
  - [ ] Add CHANGELOG.md

- [ ] **Package publishing preparation**
  - [ ] Verify package.json metadata is correct
  - [ ] Add repository, homepage, bugs URLs
  - [ ] Prepare for npm/JSR publishing (not required for launch)

---

## 🟢 Low Priority (Post-Launch)

### Features

- [ ] **DirectoryAdapter** - Local filesystem crawling
  - [ ] Non-git directory traversal
  - [ ] Mixed content type handling
  - [ ] Token-based stopping
  - [ ] Ignore patterns (.gitignore style)

- [ ] **Docker support**
  - [ ] Dockerfile for users without Bun
  - [ ] docker-compose for easy local deployment
  - [ ] Document Docker usage

- [ ] **Provider abstraction**
  - [ ] Abstract Gemini client behind interface
  - [ ] Document interface for alternative providers
  - [ ] Prepare for multi-model routing (v0.4 roadmap)

### Distribution

- [ ] **npm publishing**
  - [ ] Publish `@mnemo/core`
  - [ ] Publish `@mnemo/local`
  - [ ] Publish `@mnemo/mcp-server`

- [ ] **JSR publishing** (Deno/Bun native)
  - [ ] Configure JSR metadata
  - [ ] Publish packages

### Community

- [ ] **Issue templates**
  - [ ] Bug report template
  - [ ] Feature request template
  - [ ] Question/support template

- [ ] **PR template**
  - [ ] Checklist for contributors
  - [ ] Link to contributing guidelines

- [ ] **Community health files**
  - [ ] CODE_OF_CONDUCT.md
  - [ ] SECURITY.md (vulnerability reporting)
  - [ ] SUPPORT.md

---

## Pre-Release Final Checks

Before announcing the release:

- [ ] All high-priority items complete
- [ ] README accurately describes current capabilities
- [ ] All tests passing
- [ ] CI/CD pipeline working
- [ ] Fresh clone + install + run works
- [ ] MCP integration with Claude Code verified
- [ ] Both local and worker deployments tested
- [ ] No sensitive information in repository
- [ ] No hardcoded API keys or secrets
- [ ] License file present and correct

---

## Capability Matrix (for Documentation)

| Feature | Local Server | Worker Server |
|---------|--------------|---------------|
| Load local filesystem paths | ✅ | ❌ |
| Load GitHub repos (public) | ✅ | ✅ |
| Load GitHub repos (private) | ✅ (with token) | ✅ (with token) |
| Load arbitrary URLs | ✅ (after URL adapter) | ✅ (after URL adapter) |
| Load PDFs | ✅ (after URL adapter) | ✅ (after URL adapter) |
| Query cached context | ✅ | ✅ |
| List caches | ✅ | ✅ |
| Evict caches | ✅ | ✅ |
| Usage statistics | ✅ | ✅ |

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GEMINI_API_KEY` | Yes | - | Your Google AI Studio API key |
| `MNEMO_PORT` | No | 8080 | Server port (local only) |
| `MNEMO_DIR` | No | ~/.mnemo | Data directory (local only) |
| `MNEMO_AUTH_TOKEN` | No | - | Optional bearer token for auth |

---

## Notes

- The roadmap (v0.2-v0.5) can stay in ROADMAP.md as planned features
- Make clear distinction between "implemented" and "planned" in documentation
- URL adapter is the key new feature needed for launch
- Provider abstraction is nice-to-have but not blocking
