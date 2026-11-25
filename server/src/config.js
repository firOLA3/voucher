import crypto from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

function parseCorsOrigins(rawValue) {
  if (!rawValue) return [];
  return rawValue
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function parseSameSite(rawValue, corsOrigins, isHostedProduction) {
  if (rawValue) {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === "none" || normalized === "lax" || normalized === "strict") {
      return normalized;
    }
  }
  const hasHttpsCorsOrigin = corsOrigins.some((origin) => origin.startsWith("https://"));
  if (isHostedProduction || hasHttpsCorsOrigin) {
    return "none";
  }
  return "lax";
}

function resolveCookieSecure(rawValue, isHostedProduction) {
  if (rawValue === "1" || rawValue === "true") return true;
  if (rawValue === "0" || rawValue === "false") return false;
  return isHostedProduction;
}

export function loadConfig(env = process.env) {
  const isHostedProduction =
    env.NODE_ENV === "production" ||
    Boolean(env.RENDER) ||
    Boolean(env.RAILWAY_ENVIRONMENT);

  const configuredPassword = env.VOUCHER_ADMIN_PASSWORD || "";
  const generatedAdminPassword = !configuredPassword;
  const adminPassword = configuredPassword || crypto.randomBytes(18).toString("base64url");

  const sessionSecret = env.VOUCHER_SESSION_SECRET
    ? Buffer.from(env.VOUCHER_SESSION_SECRET, "utf8")
    : crypto.randomBytes(32);

  const corsOrigins = parseCorsOrigins(env.CORS_ORIGIN || env.FRONTEND_URL || "");
  const cookieSameSite = parseSameSite(env.VOUCHER_COOKIE_SAMESITE, corsOrigins, isHostedProduction);
  const cookieSecure = resolveCookieSecure(env.VOUCHER_COOKIE_SECURE, isHostedProduction);

  const port = Number.parseInt(env.VOUCHER_PORT || env.PORT || "8000", 10);
  const host = env.VOUCHER_HOST || (isHostedProduction ? "0.0.0.0" : "127.0.0.1");

  return {
    port: Number.isNaN(port) ? 8000 : port,
    host,
    isProduction: isHostedProduction,
    mongoUri: env.MONGODB_URI || env.MONGO_URI || "",
    defaultLimit: 100,
    maxLimit: 1_000_000,
    maxVoucherCodeLength: 256,
    maxVoucherQuestionLength: 512,
    maxVoucherAnswerLength: 256,
    answerHashIterations: Number.parseInt(env.VOUCHER_HASH_ITERATIONS || "200000", 10) || 200_000,
    sessionLifetimeSeconds: 8 * 60 * 60,
    sessionSecret,
    adminPassword,
    generatedAdminPassword,
    cookieSecure,
    cookieSameSite,
    corsOrigins,
  };
}

export const config = loadConfig();
