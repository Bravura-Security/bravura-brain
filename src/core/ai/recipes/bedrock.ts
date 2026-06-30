import type { Recipe } from '../types.ts';

/**
 * Amazon Bedrock — keyless, region-scoped access to Claude (chat/expansion)
 * and Cohere (embedding) over a single AWS auth seam.
 *
 * AUTH MODEL (the whole point of this recipe): NO static API keys. Credentials
 * resolve through the AWS default provider chain (`@aws-sdk/credential-provider-node`
 * `defaultProvider()`), which the gateway wires into `createAmazonBedrock`'s
 * `credentialProvider` hook. That chain walks, in order:
 *   env (AWS_ACCESS_KEY_ID/…) → SSO token cache → web-identity token file
 *   (EKS Pod Identity / IRSA — the production path) → shared ini profile
 *   (AWS_PROFILE — the local path) → EC2/ECS IMDS.
 * So the same recipe works unchanged in an EKS pod (Pod Identity) and on a
 * laptop (`AWS_PROFILE=...`). The `@ai-sdk/amazon-bedrock` provider on its own
 * only reads AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY from env — it does NOT
 * walk profiles or Pod Identity — which is why the gateway must inject the
 * full chain via `credentialProvider`. The recipe itself holds zero secrets.
 *
 * REGION: defaults to ca-central-1; `AWS_REGION` or `BEDROCK_REGION` override
 * (resolved in the gateway's bedrock factory). No `auth_env.required` because
 * keyless auth means there is no single env var to gate on — readiness is
 * "can the AWS chain produce credentials", surfaced at first call.
 *
 * MODEL IDS are Bedrock inference-profile IDs (region-prefixed: `global.`,
 * `us.`, …), NOT bare Anthropic API ids. The `global.` prefix routes through
 * Bedrock's global cross-region inference; `us.` pins the US geo.
 *
 * Reference: https://docs.aws.amazon.com/bedrock/latest/userguide/
 */
export const bedrock: Recipe = {
  id: 'bedrock',
  name: 'Amazon Bedrock',
  tier: 'native',
  implementation: 'native-bedrock',
  // No base_url_default: the SDK builds region-scoped Bedrock URLs itself.
  auth_env: {
    // Keyless: credentials come from the AWS default provider chain (env /
    // SSO / Pod Identity / profile / IMDS). No required env var to gate on —
    // an empty required[] makes `gbrain providers list` show this as ready
    // and defers any credential failure to the first real call, with the
    // AWS SDK's own resolution error.
    required: [],
    optional: ['AWS_REGION', 'BEDROCK_REGION', 'AWS_PROFILE'],
    setup_url:
      'https://docs.aws.amazon.com/bedrock/latest/userguide/getting-started.html',
  },
  touchpoints: {
    embedding: {
      // Cohere embed on Bedrock. embed-v4 is the default; it accepts a
      // configurable output_dimension (256/512/1024/1536) and — unlike
      // embed-english-v3, which caps input at ~2048 chars and silently
      // drops longer docs — handles long documents. embed-english-v3 is the
      // broadly-available fallback. The gateway forwards the configured
      // embedding_dimensions to Cohere v4 as `output_dimension` (see
      // dims.ts native-bedrock branch), so set --embedding-dimensions 1024.
      //
      // NOTE (verified 2026-06-22, ca-central-1): use the ON-DEMAND-capable
      // inference-profile id `global.cohere.embed-v4:0`. The BARE model id
      // `cohere.embed-v4:0` is INFERENCE_PROFILE-only there — invoking it
      // on-demand returns "Invocation of model ID cohere.embed-v4:0 with
      // on-demand throughput isn't supported." `cohere.embed-english-v3` IS
      // available on-demand directly and is the safe fallback for
      // accounts/regions without a cross-region embed inference profile.
      models: ['global.cohere.embed-v4:0', 'cohere.embed-english-v3', 'cohere.embed-multilingual-v3'],
      default_dims: 1024,
      cost_per_1m_tokens_usd: 0.12, // Cohere embed-v4 on Bedrock (approx.)
      price_last_verified: '2026-06-22',
      // Cohere's Bedrock embed endpoint caps at 96 texts / ~128K tokens per
      // request; cap conservatively so the gateway pre-splits + the
      // recursive-halving safety net engages on overflow.
      max_batch_tokens: 100_000,
    },
    expansion: {
      models: [
        'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        // Sonnet 5 used for query expansion in the Bravura deployment.
        'global.anthropic.claude-sonnet-5',
        'us.anthropic.claude-sonnet-5',
      ],
      cost_per_1m_tokens_usd: 1.0, // Haiku-class on Bedrock (approx.)
      price_last_verified: '2026-06-22',
    },
    chat: {
      // Inference-profile IDs. Default is the global Sonnet profile; the us.*
      // Opus / Haiku profiles are also supported.
      models: [
        'global.anthropic.claude-sonnet-4-6',
        'us.anthropic.claude-opus-4-8',
        'us.anthropic.claude-sonnet-4-6-v1',
        'global.anthropic.claude-haiku-4-5-20251001-v1:0',
        'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        // Verified ACTIVE on-demand inference profiles in ca-central-1
        // (2026-06-30): Opus 4.8 (enrich agent) + Sonnet 5 (general chat).
        'global.anthropic.claude-opus-4-8',
        'global.anthropic.claude-sonnet-5',
        'us.anthropic.claude-sonnet-5',
      ],
      supports_tools: true,
      supports_subagent_loop: true,
      // Prompt caching stays OFF for Bedrock. The gateway's prompt-cache path
      // (gateway.ts) injects Anthropic-native `cache_control: ephemeral` markers,
      // which only the first-party Anthropic API consumes — the AI-SDK Bedrock
      // provider uses a different Converse `cachePoint` mechanism that this recipe
      // does not wire, so claiming support would inject markers Bedrock ignores
      // (and breaks the "only the anthropic recipe claims prompt cache" invariant
      // in test/ai/gateway-chat.test.ts). Revisit if/when the gateway grows a
      // Converse cachePoint path.
      supports_prompt_cache: false,
      max_context_tokens: 200000,
      cost_per_1m_input_usd: 3.0, // sonnet-class baseline on Bedrock
      cost_per_1m_output_usd: 15.0,
      price_last_verified: '2026-06-22',
    },
    reranker: {
      // Cohere cross-encoder rerankers on Bedrock, keyless via the AWS default
      // credential chain (same auth seam as the chat/embed touchpoints —
      // gateway.rerank() routes native-bedrock recipes through a SigV4-signed
      // bedrock-runtime InvokeModel call, NOT the ZE/llama HTTP wire path).
      //
      // NOTE (verified 2026-06-22, ca-central-1): cohere.rerank-v3-5:0 is
      // ON_DEMAND / In-Region in ca-central-1 (NO inference-profile prefix —
      // the bare model id is the on-demand-invocable id; there is no
      // `global.`/`us.` rerank profile). amazon.rerank-v1:0 is the secondary
      // option. The Bedrock Cohere rerank body is `{api_version: 2, query,
      // documents, top_n?}` and the response is `{results: [{index,
      // relevance_score}]}` — the gateway's native-bedrock rerank adapter
      // builds that body and maps the response back to {index, relevanceScore}.
      models: ['cohere.rerank-v3-5:0', 'amazon.rerank-v1:0'],
      default_model: 'cohere.rerank-v3-5:0',
      // Cohere Rerank 3.5 on Bedrock: ~$2.00 / 1K queries (per the AWS Bedrock
      // pricing page) — billed per query+docs, not per token. Approximate the
      // per-1M-token figure for the budget tracker's rerank pricing lookup.
      cost_per_1m_tokens_usd: 2.0,
      price_last_verified: '2026-06-22',
      // Cohere Bedrock rerank accepts up to 1000 documents / 4K-token context
      // per call. Cap the request body conservatively; gateway.rerank()
      // pre-flights body size and fails open over-cap.
      max_payload_bytes: 5_000_000,
    },
  },
  setup_hint:
    'No API key needed. Auth uses the AWS default credential chain: run `aws sso login --profile <p>` then `export AWS_PROFILE=<p>` locally, or rely on EKS Pod Identity / IRSA in production. Set AWS_REGION or BEDROCK_REGION (default ca-central-1). Configure with e.g. `--chat-model bedrock:global.anthropic.claude-sonnet-4-6` and `--embedding-model bedrock:global.cohere.embed-v4:0 --embedding-dimensions 1024` (use the `global.` inference-profile id for embed-v4 — the bare `cohere.embed-v4:0` is profile-only and not on-demand-invocable).',
};
