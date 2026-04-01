import type {
  LambdaResponse,
  StoreChatMessageRequest,
  ChatSendRequest,
  ChatRecord,
  DeepSeekMessage,
} from "./types.js";
import {
  jsonResponse,
  normalizeEmail,
  SYSTEM_PROMPT,
  CHAT_RATE_LIMIT_MS,
  MAX_MESSAGES_PER_SESSION,
} from "./config.js";
import { getItem, appendChatMessages } from "./db.js";
import { checkTimestampRateLimit } from "./rate-limit.js";
import { callDeepSeek } from "./deepseek.js";

const POISON_PATTERNS = [
  "placeholder response",
  "AI backend is not yet connected",
  "temporarily unavailable",
];

function sanitizeHistory(
  messages: ChatSendRequest["messages"],
): Array<{ role: "user" | "assistant"; content: string }> {
  const filtered = messages.filter(
    (m) => !POISON_PATTERNS.some((p) => m.content.includes(p)),
  );

  const collapsed: typeof filtered = [];
  for (const msg of filtered) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n" + msg.content;
    } else {
      collapsed.push({ ...msg });
    }
  }

  return collapsed;
}

export async function handleStoreChatMessage(body: StoreChatMessageRequest): Promise<LambdaResponse> {
  const { email, role, content } = body;

  if (!email || !role || !content) {
    return jsonResponse(400, { error: "email, role, and content are required" });
  }

  if (role !== "user" && role !== "assistant") {
    return jsonResponse(400, { error: "role must be 'user' or 'assistant'" });
  }

  await appendChatMessages(normalizeEmail(email), [{ role, content }]);
  return jsonResponse(200, { message: "Message stored" });
}

export async function handleChatSend(body: ChatSendRequest): Promise<LambdaResponse> {
  const { email, name, messages: clientMessages } = body;

  if (!email || !Array.isArray(clientMessages) || clientMessages.length === 0) {
    return jsonResponse(400, { error: "email and messages are required" });
  }

  const normalizedEmail = normalizeEmail(email);

  const existing = await getItem<ChatRecord>(normalizedEmail, "chat");

  const rateBlock = checkTimestampRateLimit(
    existing?.updatedAt,
    CHAT_RATE_LIMIT_MS,
    "before sending another message",
  );
  if (rateBlock) return rateBlock;

  const storedCount = existing?.messages?.length ?? 0;
  if (storedCount >= MAX_MESSAGES_PER_SESSION) {
    return jsonResponse(429, {
      error: "Chat session limit reached. Please contact us directly at hello@beijaflorsolutions.com",
    });
  }

  const cleaned = sanitizeHistory(clientMessages);
  if (cleaned.length === 0) {
    return jsonResponse(400, { error: "No valid messages to process" });
  }

  const systemContent = name
    ? `${SYSTEM_PROMPT}\n\nThe user's name is ${name}.`
    : SYSTEM_PROMPT;

  const deepseekMessages: DeepSeekMessage[] = [
    { role: "system", content: systemContent },
    ...cleaned.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  try {
    const result = await callDeepSeek(deepseekMessages);
    console.log("DeepSeek response:", JSON.stringify(result));

    const assistantContent = result.choices?.[0]?.message?.content;

    if (!assistantContent) {
      console.error("Empty DeepSeek response:", JSON.stringify(result));
      return jsonResponse(502, { error: "Failed to get a response from the AI" });
    }

    if (assistantContent.toLowerCase().includes("service temporarily unavailable")) {
      console.error("DeepSeek service error as content:", assistantContent);
      return jsonResponse(503, { error: "AI service is busy. Please try again in a moment." });
    }

    const lastUserMsg = cleaned[cleaned.length - 1];
    await appendChatMessages(normalizedEmail, [
      { role: lastUserMsg.role, content: lastUserMsg.content },
      { role: "assistant", content: assistantContent },
    ]);

    return jsonResponse(200, { message: assistantContent, usage: result.usage ?? null });
  } catch (err) {
    console.error("DeepSeek API error:", err);
    return jsonResponse(502, { error: "AI service temporarily unavailable. Please try again." });
  }
}

