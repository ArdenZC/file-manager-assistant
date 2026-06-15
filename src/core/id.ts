import crypto from "node:crypto";

export function stableId(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

