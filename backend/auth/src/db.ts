import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { DynamoKey, RecordType, ChatMessage } from "./types.js";
import { env } from "./config.js";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: env.region })
);

function key(email: string, recordType: RecordType): DynamoKey {
  return { email, recordType };
}

export async function getItem<T>(email: string, recordType: RecordType): Promise<T | undefined> {
  const result = await ddb.send(
    new GetCommand({ TableName: env.tableName, Key: key(email, recordType) })
  );
  return result.Item as T | undefined;
}

export async function putItem(item: Record<string, unknown>): Promise<void> {
  await ddb.send(new PutCommand({ TableName: env.tableName, Item: item }));
}

export async function deleteItem(email: string, recordType: RecordType): Promise<void> {
  await ddb.send(
    new DeleteCommand({ TableName: env.tableName, Key: key(email, recordType) })
  );
}

export async function conditionalPut(
  item: Record<string, unknown>,
  conditionExpression: string,
  expressionValues: Record<string, unknown>,
): Promise<boolean> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: env.tableName,
        Item: item,
        ConditionExpression: conditionExpression,
        ExpressionAttributeValues: expressionValues,
      })
    );
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      return false;
    }
    throw err;
  }
}

export async function appendChatMessages(
  email: string,
  messages: Array<Omit<ChatMessage, "timestamp">>,
): Promise<void> {
  const now = Date.now();
  const timestamped = messages.map((m) => ({ ...m, timestamp: now }));

  await ddb.send(
    new UpdateCommand({
      TableName: env.tableName,
      Key: key(email, "chat"),
      UpdateExpression:
        "SET createdAt = if_not_exists(createdAt, :now), " +
        "#msgs = list_append(if_not_exists(#msgs, :empty), :newMsgs), " +
        "updatedAt = :now",
      ExpressionAttributeNames: { "#msgs": "messages" },
      ExpressionAttributeValues: {
        ":now": now,
        ":empty": [],
        ":newMsgs": timestamped,
      },
    })
  );
}

