// Types
export * from './types';

// LLM Client Interface & Utilities
export * from './llm-client';

// Gemini Client
export { GeminiClient } from './gemini-client';

// Local LLM Client (for vLLM, Ollama, etc.)
export { LocalLLMClient, InMemoryContentStore, type ContentStore } from './local-llm-client';

// Fallback LLM Client (local primary, Gemini fallback)
export { FallbackLLMClient, type FallbackLLMClientConfig } from './fallback-llm-client';

// Async LLM Client (HTTP polling for long queries)
export { AsyncLLMClient, AsyncQueryError, type AsyncQueryConfig } from './async-llm-client';

// Loaders
export { RepoLoader, loadGitHubRepo, loadGitHubRepoViaAPI, isUrl, isGitHubUrl, type GitHubLoadOptions } from './repo-loader';
export { SourceLoader } from './source-loader';

// Adapters (v0.2)
export * from './adapters';

// Chunker (v0.3 - RAG support)
export * from './chunker';

// Vectorize Client (v0.3 - RAG support)
export * from './vectorize-client';
