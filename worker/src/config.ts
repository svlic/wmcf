import type { Env, TelegramCredentials } from "./types";

// Keep password hashing within the 10 ms CPU budget of Workers Free requests.
const PASSWORD_ITERATIONS = 20_000;
const encoder = new TextEncoder();

export interface AppConfigRow {
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  session_secret: string;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EffectiveAuthConfig {
  enabled: boolean;
  sessionSecret: string | null;
  row: AppConfigRow | null;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function randomSecret(bytes: number): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64(value);
}

async function derivePassword(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string; iterations: number }> {
  const salt = new Uint8Array(new ArrayBuffer(16));
  crypto.getRandomValues(salt);
  return {
    hash: encodeBase64(await derivePassword(password, salt, PASSWORD_ITERATIONS)),
    salt: encodeBase64(salt),
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(password: string, row: AppConfigRow): Promise<boolean> {
  const actual = await derivePassword(password, decodeBase64(row.password_salt), row.password_iterations);
  const expected = decodeBase64(row.password_hash);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}

export function newSessionSecret(): string {
  return randomSecret(32);
}

export async function loadAppConfig(db: D1Database): Promise<AppConfigRow | null> {
  return db.prepare("SELECT password_hash,password_salt,password_iterations,session_secret,telegram_bot_token,telegram_chat_id FROM app_config WHERE singleton=1").first<AppConfigRow>();
}

export async function effectiveAuthConfig(env: Env): Promise<EffectiveAuthConfig> {
  const row = await loadAppConfig(env.DB);
  if (row !== null) return { enabled: true, sessionSecret: row.session_secret, row };
  return {
    enabled: Boolean(env.WAVEMONITOR_WEB_PASSWORD),
    sessionSecret: env.WAVEMONITOR_SESSION_SECRET ?? null,
    row: null,
  };
}

export async function passwordMatches(password: string, env: Env, config: EffectiveAuthConfig): Promise<boolean> {
  if (config.row !== null) return verifyPassword(password, config.row);
  return password === env.WAVEMONITOR_WEB_PASSWORD;
}

export async function loadTelegramCredentials(env: Env): Promise<TelegramCredentials | null> {
  const row = await loadAppConfig(env.DB);
  if (row !== null) {
    return row.telegram_bot_token && row.telegram_chat_id
      ? { token: row.telegram_bot_token, chatId: row.telegram_chat_id }
      : null;
  }
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  return token && chatId ? { token, chatId } : null;
}
