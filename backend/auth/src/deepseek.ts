import type { DeepSeekMessage, DeepSeekResponse } from "./types.js";
import { env, DEEPSEEK_TIMEOUT_MS, DEEPSEEK_MAX_TOKENS } from "./config.js";

export async function callDeepSeek(messages: DeepSeekMessage[]): Promise<DeepSeekResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEEPSEEK_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.deepseekApiKey}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        max_tokens: DEEPSEEK_MAX_TOKENS,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });

    const data = await res.json() as DeepSeekResponse;

    if (!res.ok) {
      throw new Error(`DeepSeek API ${res.status}: ${JSON.stringify(data)}`);
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

