import type { LambdaResponse } from "./types.js";

// --- Environment ---

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

export const env = {
  tableName: requireEnv("TABLE_NAME"),
  senderEmail: requireEnv("SENDER_EMAIL"),
  deepseekApiKey: requireEnv("DEEPSEEK_API_KEY"),
  region: process.env.AWS_REGION ?? "us-east-1",
} as const;

// --- Constants ---

export const GLOBAL_RATE_KEY = "__GLOBAL_RATE_LIMIT__";

export const RATE_LIMIT_MS = 15_000;
export const CODE_TTL_SECONDS = 600;
export const MAX_VERIFY_ATTEMPTS = 3;
export const CHAT_RATE_LIMIT_MS = 5_000;
export const MAX_MESSAGES_PER_SESSION = 50;
export const DEEPSEEK_TIMEOUT_MS = 50_000;
export const DEEPSEEK_MAX_TOKENS = 1024;

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- Shared helpers ---

const CORS_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(statusCode: number, body: Record<string, unknown>): LambdaResponse {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function sanitizeName(name: string | undefined): string {
  return (name ?? "").replace(/[<>&"'/]/g, "").slice(0, 100);
}

export const SYSTEM_PROMPT = `You are the AI assistant for Beija-Flor Solutions, a technology consulting company. Your role is to help potential clients refine their project ideas and explore how Beija-Flor Solutions can bring them to life.

About the company:
- Founded by Thomas Bunke, M.Sc. Mathematics, AWS Certified Solutions Architect and Advanced Networking Specialist
- 27+ years of object-oriented development experience
- Services: AI Solutions (generative AI, LLM inference, prompt engineering, data privacy), End-to-End Solutions (cloud, DevOps, full-stack, security, data science, IoT/Industrial), and Customer Interaction (corporate identity, UI/UX, accessibility)
- Tech stack: AWS, Azure, Python, TypeScript, Terraform, Docker, Kubernetes
- Values: mindful communication, value-driven business, mastering complexity

Your behavior:
- Be friendly, professional, and consultative
- Help users articulate and refine their project ideas
- Ask clarifying questions to understand scope, goals, and constraints
- Suggest appropriate technology stacks and approaches
- Outline potential roadmaps and next steps
- Keep responses concise (under 250 words) and focused
- If a question is outside your scope, gently redirect to the company's services
- Respond in the same language the user writes in
- Use markdown formatting for readability`;

