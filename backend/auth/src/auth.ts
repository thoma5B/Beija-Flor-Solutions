import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import crypto from "crypto";
import type { LambdaResponse, SendCodeRequest, VerifyCodeRequest, VerificationRecord } from "./types.js";
import {
  env,
  jsonResponse,
  normalizeEmail,
  sanitizeName,
  EMAIL_REGEX,
  RATE_LIMIT_MS,
  CODE_TTL_SECONDS,
  MAX_VERIFY_ATTEMPTS,
} from "./config.js";
import { getItem, putItem, deleteItem } from "./db.js";
import { checkAtomicGlobalRateLimit, checkTimestampRateLimit } from "./rate-limit.js";

const ses = new SESClient({ region: env.region });

function generateCode(): string {
  return crypto.randomInt(100_000, 999_999).toString();
}

function verificationEmail(name: string, code: string): { html: string; text: string } {
  const greeting = name ? ` ${name}` : "";
  return {
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h2>Hello${greeting}!</h2>
        <p>Your verification code is:</p>
        <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; text-align: center; padding: 20px; background: #f4f4f5; border-radius: 8px; margin: 16px 0;">
          ${code}
        </div>
        <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, please ignore this email.</p>
      </div>`,
    text: `Hello${greeting}! Your verification code is: ${code}. It expires in 10 minutes.`,
  };
}

export async function handleSendCode(body: SendCodeRequest): Promise<LambdaResponse> {
  const { email, name } = body;

  if (!email || typeof email !== "string" || !EMAIL_REGEX.test(email)) {
    return jsonResponse(400, { error: "Invalid email address" });
  }

  const normalizedEmail = normalizeEmail(email);
  const sanitized = sanitizeName(name);

  const globalBlock = await checkAtomicGlobalRateLimit(RATE_LIMIT_MS);
  if (globalBlock) return globalBlock;

  const existing = await getItem<VerificationRecord>(normalizedEmail, "verification");
  const perEmailBlock = checkTimestampRateLimit(
    existing?.sentAt,
    RATE_LIMIT_MS,
    "before requesting a new code",
  );
  if (perEmailBlock) return perEmailBlock;

  const code = generateCode();
  const now = Date.now();

  await putItem({
    email: normalizedEmail,
    recordType: "verification",
    code,
    name: sanitized,
    sentAt: now,
    attempts: 0,
    ttl: Math.floor(now / 1000) + CODE_TTL_SECONDS,
  });

  const { html, text } = verificationEmail(sanitized, code);

  await ses.send(
    new SendEmailCommand({
      Source: env.senderEmail,
      Destination: { ToAddresses: [normalizedEmail] },
      Message: {
        Subject: { Data: "Your verification code - Beija-Flor Solutions" },
        Body: {
          Html: { Data: html },
          Text: { Data: text },
        },
      },
    })
  );

  return jsonResponse(200, { message: "Verification code sent" });
}

export async function handleVerifyCode(body: VerifyCodeRequest): Promise<LambdaResponse> {
  const { email, code } = body;

  if (!email || !code) {
    return jsonResponse(400, { error: "Email and code are required" });
  }

  const normalizedEmail = normalizeEmail(email);
  const record = await getItem<VerificationRecord>(normalizedEmail, "verification");

  if (!record) {
    return jsonResponse(400, { error: "No verification code found. Please request a new one." });
  }

  if (record.attempts >= MAX_VERIFY_ATTEMPTS) {
    await deleteItem(normalizedEmail, "verification");
    return jsonResponse(429, { error: "Too many attempts. Please request a new code." });
  }

  if (record.code !== code.trim()) {
    await putItem({ ...record, attempts: record.attempts + 1 });
    return jsonResponse(401, { error: "Invalid code" });
  }

  await deleteItem(normalizedEmail, "verification");
  return jsonResponse(200, { message: "Verified", email: normalizedEmail, name: record.name });
}

