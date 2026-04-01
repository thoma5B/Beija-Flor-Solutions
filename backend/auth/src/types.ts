import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

// --- Lambda request/response ---

export type LambdaResponse = APIGatewayProxyResultV2;
export type LambdaEvent = APIGatewayProxyEventV2;

// --- DynamoDB record types ---

export type RecordType = "verification" | "chat";

export interface DynamoKey {
  email: string;
  recordType: RecordType;
}

export interface VerificationRecord extends DynamoKey {
  recordType: "verification";
  code: string;
  name: string;
  sentAt: number;
  attempts: number;
  ttl: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface ChatRecord extends DynamoKey {
  recordType: "chat";
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

// --- API request bodies ---

export interface SendCodeRequest {
  email: string;
  name?: string;
}

export interface VerifyCodeRequest {
  email: string;
  code: string;
}

export interface StoreChatMessageRequest {
  email: string;
  role: "user" | "assistant";
  content: string;
}

export interface ChatSendRequest {
  email: string;
  name?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}

// --- DeepSeek API ---

export interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface DeepSeekResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: DeepSeekUsage;
}

