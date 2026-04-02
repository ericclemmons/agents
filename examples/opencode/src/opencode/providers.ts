import type { Config } from "@opencode-ai/sdk/v2";
import type {
  ProviderID,
  ProviderCredentials,
  ResolvedProvider
} from "./types";

// ── Provider config builders ─────────────────────────────────────────

/**
 * Build an OpenCode Config for Cloudflare Workers AI.
 * The baseURL is set explicitly with the account ID baked in because
 * the provider's env-var interpolation does not work reliably inside
 * the sandbox container.
 */
function buildCloudflareConfig(accountId: string): Config {
  return {
    model: "cloudflare-workers-ai/@cf/moonshotai/kimi-k2.5",
    provider: {
      "cloudflare-workers-ai": {
        options: {
          baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
        },
        models: {
          "@cf/moonshotai/kimi-k2.5": {}
        }
      }
    },
    permission: {
      "*": "allow",
      question: "deny"
    },
    autoupdate: false
  };
}

/** Build an OpenCode Config for Anthropic. */
function buildAnthropicConfig(): Config {
  return {
    model: "anthropic/claude-sonnet-4-20250514",
    provider: {
      anthropic: {
        options: {},
        models: {
          "claude-sonnet-4-20250514": {}
        }
      }
    },
    permission: {
      "*": "allow",
      question: "deny"
    },
    autoupdate: false
  };
}

/** Build an OpenCode Config for OpenAI. */
function buildOpenAIConfig(): Config {
  return {
    model: "openai/gpt-5.4",
    provider: {
      openai: {
        options: {},
        models: {
          "gpt-5.4": {}
        }
      }
    },
    permission: {
      "*": "allow",
      question: "deny"
    },
    autoupdate: false
  };
}

// ── Resolver ─────────────────────────────────────────────────────────

/**
 * Resolve provider credentials into a full configuration for the
 * OpenCode session inside the sandbox.
 */
export function resolveProvider(creds: ProviderCredentials): ResolvedProvider {
  switch (creds.provider) {
    case "cloudflare-workers-ai":
      return {
        id: "cloudflare-workers-ai",
        config: buildCloudflareConfig(creds.accountId),
        env: {
          CLOUDFLARE_ACCOUNT_ID: creds.accountId,
          CLOUDFLARE_API_KEY: creds.apiKey
        },
        auth: {
          providerID: "cloudflare-workers-ai",
          auth: { type: "api", key: creds.apiKey }
        }
      };

    case "anthropic":
      return {
        id: "anthropic",
        config: buildAnthropicConfig(),
        env: {
          ANTHROPIC_API_KEY: creds.apiKey
        },
        auth: {
          providerID: "anthropic",
          auth: { type: "api", key: creds.apiKey }
        }
      };

    case "openai":
      return {
        id: "openai",
        config: buildOpenAIConfig(),
        env: {
          OPENAI_API_KEY: creds.apiKey
        },
        auth: {
          providerID: "openai",
          auth: { type: "api", key: creds.apiKey }
        }
      };
  }
}

/**
 * Auto-detect provider credentials from environment variables.
 * Checks in order: OpenAI, Anthropic, Cloudflare Workers AI.
 * Returns null if no provider credentials are found.
 */
export function detectProvider(
  env: Record<string, unknown>
): ProviderCredentials | null {
  // OpenAI
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY) {
    return { provider: "openai", apiKey: env.OPENAI_API_KEY };
  }

  // Anthropic
  if (typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", apiKey: env.ANTHROPIC_API_KEY };
  }

  // Cloudflare Workers AI
  if (
    typeof env.CLOUDFLARE_ACCOUNT_ID === "string" &&
    env.CLOUDFLARE_ACCOUNT_ID &&
    typeof env.CLOUDFLARE_API_KEY === "string" &&
    env.CLOUDFLARE_API_KEY
  ) {
    return {
      provider: "cloudflare-workers-ai",
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      apiKey: env.CLOUDFLARE_API_KEY
    };
  }

  return null;
}

/**
 * Describe which env vars are needed for each provider.
 * Used in error messages to guide the user.
 */
export function describeRequiredEnvVars(): string {
  return [
    "Set one of the following provider credentials:",
    "  • ANTHROPIC_API_KEY — for Anthropic (Claude)",
    "  • OPENAI_API_KEY — for OpenAI (GPT-4)",
    "  • CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_KEY — for Cloudflare Workers AI"
  ].join("\n");
}

/**
 * Get the provider ID for display purposes.
 */
export function getProviderDisplayName(id: ProviderID): string {
  switch (id) {
    case "cloudflare-workers-ai":
      return "Cloudflare Workers AI";
    case "anthropic":
      return "Anthropic";
    case "openai":
      return "OpenAI";
  }
}
