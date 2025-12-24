import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

// Workflow parameters
export interface QueryWorkflowParams {
  jobId: string;
  alias: string;
  query: string;
  maxTokens?: number;
  temperature?: number;
}

// Local model configuration (same as index.ts)
const LOCAL_MODEL_URL = 'https://vllm.shiftaltcreate.com';
const LOCAL_MODEL_NAME = 'nemotron-3-nano';

/**
 * QueryWorkflow handles long-running context queries asynchronously.
 * This allows queries to take longer than Cloudflare's tunnel timeout.
 */
export class QueryWorkflow extends WorkflowEntrypoint<Env, QueryWorkflowParams> {
  async run(event: WorkflowEvent<QueryWorkflowParams>, step: WorkflowStep) {
    const { jobId, alias, query, maxTokens, temperature } = event.payload;

    // Step 1: Mark job as running
    await step.do('mark-running', async () => {
      await this.env.DB.prepare(
        'UPDATE workflow_jobs SET status = ? WHERE id = ?'
      ).bind('running', jobId).run();
    });

    // Step 2: Get cached content from D1
    const cachedContent = await step.do('get-cached-content', async () => {
      // First get the cache metadata
      const cache = await this.env.DB.prepare(
        'SELECT gemini_cache_name FROM caches WHERE alias = ?'
      ).bind(alias).first<{ gemini_cache_name: string }>();

      if (!cache) {
        throw new Error(`Cache not found: ${alias}`);
      }

      // Get the actual content
      const content = await this.env.DB.prepare(
        'SELECT content FROM cache_content WHERE cache_name = ?'
      ).bind(cache.gemini_cache_name).first<{ content: string }>();

      if (!content) {
        throw new Error(`Cache content not found for: ${alias}`);
      }

      return content.content;
    });

    // Step 3: Call vLLM (the long-running part)
    const result = await step.do('query-llm', async () => {
      const messages = [
        {
          role: 'system',
          content: `You are a helpful assistant. Use the following context to answer questions:\n\n${cachedContent}`,
        },
        {
          role: 'user',
          content: query,
        },
      ];

      const response = await fetch(`${LOCAL_MODEL_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LOCAL_MODEL_NAME,
          messages,
          max_tokens: maxTokens ?? 4096,
          temperature: temperature ?? 0.7,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`LLM request failed: ${response.status} - ${error}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      return {
        response: data.choices[0]?.message?.content ?? '',
        tokensUsed: (data.usage?.prompt_tokens ?? 0) + (data.usage?.completion_tokens ?? 0),
        cachedTokensUsed: data.usage?.prompt_tokens ?? 0,
        model: LOCAL_MODEL_NAME,
      };
    });

    // Step 4: Store result and mark complete
    await step.do('store-result', async () => {
      await this.env.DB.prepare(
        `UPDATE workflow_jobs
         SET status = ?, result = ?, tokens_used = ?, cached_tokens_used = ?, completed_at = ?
         WHERE id = ?`
      ).bind(
        'complete',
        JSON.stringify(result),
        result.tokensUsed,
        result.cachedTokensUsed,
        new Date().toISOString(),
        jobId
      ).run();
    });

    return result;
  }
}
