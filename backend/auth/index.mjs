import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import crypto from "crypto";
import https from "https";

const ses = new SESClient({ region: process.env.AWS_REGION });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));

const TABLE_NAME = process.env.TABLE_NAME;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const RATE_LIMIT_MS = 15_000; // 15 seconds
const CODE_TTL_SECONDS = 600; // 10 minutes
const MAX_VERIFY_ATTEMPTS = 3;
const CHAT_RATE_LIMIT_MS = 5_000; // 5 seconds between messages
const MAX_MESSAGES_PER_SESSION = 50;

const GLOBAL_RATE_KEY = "__GLOBAL_RATE_LIMIT__";
const RT_VERIFICATION = "verification";
const RT_CHAT = "chat";

const SYSTEM_PROMPT = `You are the AI assistant for Beija-Flor Solutions, a technology consulting company. Your role is to help potential clients refine their project ideas and explore how Beija-Flor Solutions can bring them to life.

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
          recordType: RT_VERIFICATION,
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
        new GetCommand({ TableName: TABLE_NAME, Key: { email: GLOBAL_RATE_KEY, recordType: RT_VERIFICATION } })
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
    new GetCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail, recordType: RT_VERIFICATION } })
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
        recordType: RT_VERIFICATION,
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
    new GetCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail, recordType: RT_VERIFICATION } })
  );

  if (!result.Item) {
    return response(400, { error: "No verification code found. Please request a new one." });
  }

  if (result.Item.attempts >= MAX_VERIFY_ATTEMPTS) {
    await ddb.send(
      new DeleteCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail, recordType: RT_VERIFICATION } })
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
    new DeleteCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail, recordType: RT_VERIFICATION } })
  );

  return response(200, { message: "Verified", email: normalizedEmail, name: result.Item.name });
}

async function handleChatMessage(body) {
  const { email, role, content } = body;

  if (!email || !role || !content) {
    return response(400, { error: "email, role, and content are required" });
  }

  if (!["user", "assistant"].includes(role)) {
    return response(400, { error: "role must be 'user' or 'assistant'" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const now = Date.now();

  await ddb.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { email: normalizedEmail, recordType: RT_CHAT },
      UpdateExpression:
        "SET createdAt = if_not_exists(createdAt, :now), #msgs = list_append(if_not_exists(#msgs, :empty), :newMsg), updatedAt = :now",
      ExpressionAttributeNames: {
        "#msgs": "messages",
      },
      ExpressionAttributeValues: {
        ":now": now,
        ":empty": [],
        ":newMsg": [{ role, content, timestamp: now }],
      },
    })
  );

  return response(200, { message: "Message stored" });
}

function callDeepSeek(messages) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: "deepseek-chat",
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    });

    const req = https.request(
      {
        hostname: "api.deepseek.com",
        path: "/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200) {
              reject(new Error(`DeepSeek API ${res.statusCode}: ${data}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse DeepSeek response: ${data}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(50_000, () => {
      req.destroy(new Error("DeepSeek API timeout"));
    });
    req.write(payload);
    req.end();
  });
}

async function persistChatMessages(normalizedEmail, newMessages) {
  const now = Date.now();
  for (const msg of newMessages) {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { email: normalizedEmail, recordType: RT_CHAT },
        UpdateExpression:
          "SET createdAt = if_not_exists(createdAt, :now), #msgs = list_append(if_not_exists(#msgs, :empty), :newMsg), updatedAt = :now",
        ExpressionAttributeNames: { "#msgs": "messages" },
        ExpressionAttributeValues: {
          ":now": now,
          ":empty": [],
          ":newMsg": [{ ...msg, timestamp: now }],
        },
      })
    );
  }
}

async function handleChat(body) {
  const { email, name, messages: clientMessages } = body;

  if (!email || !clientMessages || !Array.isArray(clientMessages) || clientMessages.length === 0) {
    return response(400, { error: "email and messages are required" });
  }

  const normalizedEmail = email.trim().toLowerCase();
  const now = Date.now();

  // Rate limit: check last message timestamp
  const existing = await ddb.send(
    new GetCommand({ TableName: TABLE_NAME, Key: { email: normalizedEmail, recordType: RT_CHAT } })
  );

  if (existing.Item?.updatedAt && now - existing.Item.updatedAt < CHAT_RATE_LIMIT_MS) {
    const waitSeconds = Math.ceil((CHAT_RATE_LIMIT_MS - (now - existing.Item.updatedAt)) / 1000);
    return response(429, { error: `Please wait ${waitSeconds} seconds before sending another message` });
  }

  // Cap total messages per session
  const storedCount = existing.Item?.messages?.length || 0;
  if (storedCount >= MAX_MESSAGES_PER_SESSION) {
    return response(429, { error: "Chat session limit reached. Please contact us directly at hello@beijaflorsolutions.com" });
  }

  // Build DeepSeek messages array: system + conversation history
  const deepseekMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...clientMessages.map((m) => ({ role: m.role, content: m.content })),
  ];

  // Optionally inject user's name into first user message context
  if (name) {
    deepseekMessages[0].content += `\n\nThe user's name is ${name}.`;
  }

  try {
    const result = await callDeepSeek(deepseekMessages);
    const assistantContent = result.choices?.[0]?.message?.content;

    if (!assistantContent) {
      console.error("Empty DeepSeek response:", JSON.stringify(result));
      return response(502, { error: "Failed to get a response from the AI" });
    }

    // Get the last user message to persist
    const lastUserMsg = clientMessages[clientMessages.length - 1];

    // Persist both user message and assistant response
    // Only persist the NEW user message (the last one) — earlier messages are already stored
    await persistChatMessages(normalizedEmail, [
      { role: lastUserMsg.role, content: lastUserMsg.content },
      { role: "assistant", content: assistantContent },
    ]);

    return response(200, {
      message: assistantContent,
      usage: result.usage || null,
    });
  } catch (err) {
    console.error("DeepSeek API error:", err);
    return response(502, { error: "AI service temporarily unavailable. Please try again." });
  }
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

  if (path.endsWith("/chat/message")) {
    return handleChatMessage(body);
  }

  if (path.endsWith("/chat/send")) {
    return handleChat(body);
  }

  return response(404, { error: "Not found" });
};
