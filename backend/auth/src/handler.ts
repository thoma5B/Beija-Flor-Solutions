import type { LambdaEvent, LambdaResponse } from "./types.js";
import { jsonResponse } from "./config.js";
import { handleSendCode, handleVerifyCode } from "./auth.js";
import { handleStoreChatMessage, handleChatSend } from "./chat.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Route = (body: any) => Promise<LambdaResponse>;

const routes: Record<string, Route> = {
  "/auth/email": handleSendCode,
  "/auth/verification-code": handleVerifyCode,
  "/chat/message": handleStoreChatMessage,
  "/chat/send": handleChatSend,
};

function matchRoute(path: string): Route | undefined {
  return Object.entries(routes).find(([suffix]) => path.endsWith(suffix))?.[1];
}

function parseBody(event: LambdaEvent): Record<string, unknown> {
  const raw = event.body;
  if (!raw) throw new Error("Missing body");
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
  const method = event.requestContext?.http?.method ?? "";

  if (method === "OPTIONS") {
    return jsonResponse(204, {});
  }

  if (method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  const path = event.requestContext?.http?.path ?? event.rawPath ?? "";
  const route = matchRoute(path);

  if (!route) {
    return jsonResponse(404, { error: "Not found" });
  }

  let body: Record<string, unknown>;
  try {
    body = parseBody(event);
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  return route(body);
};
