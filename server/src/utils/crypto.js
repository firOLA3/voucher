import crypto from "node:crypto";
import { config } from "../config.js";
import { VoucherError } from "../errors.js";

/**
 * Constant-time UTF-8 string comparison without leaking byte length.
 */
export function timingSafeEqualStrings(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  if (leftBuf.length !== rightBuf.length) {
    // Compare leftBuf against itself so timing doesn't immediately short-circuit on mismatch.
    crypto.timingSafeEqual(leftBuf, leftBuf);
    return false;
  }
  return crypto.timingSafeEqual(leftBuf, rightBuf);
}

export function normalizeVoucherCode(rawCode) {
  if (typeof rawCode !== "string" || rawCode.length === 0) {
    throw new VoucherError(400, "invalid_code", "Enter a voucher code.");
  }
  if (rawCode.length > config.maxVoucherCodeLength) {
    throw new VoucherError(
      400,
      "invalid_code",
      `Voucher codes must be ${config.maxVoucherCodeLength} characters or fewer.`,
    );
  }
  return rawCode;
}

export function normalizeVoucherQuestion(rawQuestion) {
  if (typeof rawQuestion !== "string" || !rawQuestion.trim()) {
    throw new VoucherError(400, "invalid_question", "Enter a voucher question.");
  }
  if (rawQuestion.length > config.maxVoucherQuestionLength) {
    throw new VoucherError(
      400,
      "invalid_question",
      `Questions must be ${config.maxVoucherQuestionLength} characters or fewer.`,
    );
  }
  return rawQuestion;
}

export function normalizeVoucherAnswer(rawAnswer) {
  if (typeof rawAnswer !== "string" || !rawAnswer.trim()) {
    throw new VoucherError(400, "invalid_answer", "Enter an answer.");
  }
  if (rawAnswer.length > config.maxVoucherAnswerLength) {
    throw new VoucherError(
      400,
      "invalid_answer",
      `Answers must be ${config.maxVoucherAnswerLength} characters or fewer.`,
    );
  }
  return rawAnswer.normalize("NFKC").trim().toLowerCase();
}

export function hashVoucherAnswer(normalizedAnswer, saltHex, iterations = config.answerHashIterations) {
  return crypto
    .pbkdf2Sync(normalizedAnswer, Buffer.from(saltHex, "hex"), iterations, 32, "sha256")
    .toString("hex");
}

export function signSessionToken(secretBuffer, lifetimeSeconds = config.sessionLifetimeSeconds) {
  const expires = Math.floor(Date.now() / 1000) + lifetimeSeconds;
  const value = String(expires);
  const signature = crypto
    .createHmac("sha256", secretBuffer)
    .update(value, "ascii")
    .digest("hex");
  return `${value}.${signature}`;
}

export function verifySessionToken(token, secretBuffer) {
  if (typeof token !== "string") return false;
  const separatorIndex = token.indexOf(".");
  if (separatorIndex <= 0) return false;

  const expiresText = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  if (!/^\d+$/.test(expiresText)) return false;

  const expires = Number.parseInt(expiresText, 10);
  if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secretBuffer)
    .update(expiresText, "ascii")
    .digest("hex");
  return timingSafeEqualStrings(signature, expected);
}

