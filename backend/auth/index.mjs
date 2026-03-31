import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";

const ses = new SESClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const TABLE_NAME = process.env.TABLE_NAME;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const RATE_LIMIT_MS = 15_000; // 15 seconds
const CODE_TTL_SECONDS = 600; // 10 minutes
const MAX_VERIFY_ATTEMPTS = 3;

const GLOBAL_RATE_KEY = "__GLOBAL_RATE_LIMIT__";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function generateCode() {
  return crypto.randomInt(100000, 999999).toString();
}

async function handleSendCode(body) {
  const { email, name } = body;

  if (!email || typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return response(400, { error: "Invalid email address" });
  }

  const sanitizedName = (name || "").replace(/[<>&"'/]/g, "").slice(0, 100);
  const normalizedEmail = email.trim().toLowerCase();
  const now = Date.now();

  // Atomic global rate-limit: only succeeds if no entry exists OR sentAt is old enough
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          email: GLOBAL_RATE_KEY,
          sentAt: now,
          ttl: Math.floor(now / 1000) + 60,
        },
        ConditionExpression:
          "attribute_not_exists(sentAt) OR sentAt < :cutoff",
        ExpressionAttributeValues: {
          ":cutoff": now - RATE_LIMIT_MS,
        },
      })
    );
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      // Fetch to tell the user how long to wait
      const globalEntry = await ddb.send(
        new GetCommand({ TableName: TABLE_NAME, Key: { email: GLOBAL_RATE_KEY } })
      );
      const elapsed = now - (globalEntry.Item?.sentAt ?? 0);
      const waitSeconds = Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
      return response(429, {
        error: `Please wait ${waitSeconds} seconds before requesting a new code`,
      });
    }
    throw err;
  }

  // Per-email rate-limit check
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail } })
  );

  if (existing.Item?.sentAt && now - existing.Item.sentAt < RATE_LIMIT_MS) {
    const waitSeconds = Math.ceil((RATE_LIMIT_MS - (now - existing.Item.sentAt)) / 1000);
    return response(429, {
      error: `Please wait ${waitSeconds} seconds before requesting a new code`,
    });
  }

  const code = generateCode();
  const ttl = Math.floor(now / 1000) + CODE_TTL_SECONDS;

  // Store code in DynamoDB
  await ddb.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        email: normalizedEmail,
        code,
        name: sanitizedName,
        sentAt: now,
        attempts: 0,
        ttl,
      },
    })
  );

  // Send email via SES
  await ses.send(
    new SendEmailCommand({
      Source: SENDER_EMAIL,
      Destination: { ToAddresses: [normalizedEmail] },
      Message: {
        Subject: { Data: "Your verification code - Beija-Flor Solutions" },
        Body: {
          Html: {
            Data: `
              <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
                <h2>Hello${sanitizedName ? ` ${sanitizedName}` : ""}!</h2>
                <p>Your verification code is:</p>
                <div style="font-size: 32px; font-weight: bold; letter-spacing: 6px; text-align: center; padding: 20px; background: #f4f4f5; border-radius: 8px; margin: 16px 0;">
                  ${code}
                </div>
                <p style="color: #666; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, please ignore this email.</p>
              </div>
            `,
          },
          Text: {
            Data: `Hello${sanitizedName ? ` ${sanitizedName}` : ""}! Your verification code is: ${code}. It expires in 10 minutes.`,
          },
        },
      },
    })
  );

  return response(200, { message: "Verification code sent" });
}

async function handleVerifyCode(body) {
  const { email, code } = body;

  if (!email || !code) {
    return response(400, { error: "Email and code are required" });
  }

  const normalizedEmail = email.trim().toLowerCase();

  const result = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail } })
  );

  if (!result.Item) {
    return response(400, { error: "No verification code found. Please request a new one." });
  }

  if (result.Item.attempts >= MAX_VERIFY_ATTEMPTS) {
    await ddb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail } })
    );
    return response(429, { error: "Too many attempts. Please request a new code." });
  }

  if (result.Item.code !== code.trim()) {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { ...result.Item, attempts: (result.Item.attempts || 0) + 1 },
      })
    );
    return response(401, { error: "Invalid code" });
  }

  // Success – clean up
  await ddb.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail } })
  );

  return response(200, { message: "Verified", email: normalizedEmail, name: result.Item.name });
}

export const handler = async (event) => {
  // Handle CORS preflight
  if (event.requestContext?.http?.method === "OPTIONS") {
    return response(204, {});
  }

  const path = event.requestContext?.http?.path || event.rawPath || "";
  const method = event.requestContext?.http?.method || event.httpMethod || "";

  if (method !== "POST") {
    return response(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
  } catch {
    return response(400, { error: "Invalid JSON body" });
  }

  if (path.endsWith("/auth/email")) {
    return handleSendCode(body);
  }

  if (path.endsWith("/auth/verification-code")) {
    return handleVerifyCode(body);
  }

  return response(404, { error: "Not found" });
};
