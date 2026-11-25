import crypto from "node:crypto";
import { config } from "../config.js";
import { VoucherError } from "../errors.js";
import { CampaignSettings } from "../models/CampaignSettings.js";
import { Voucher } from "../models/Voucher.js";
import {
  hashVoucherAnswer,
  normalizeVoucherAnswer,
  normalizeVoucherCode,
  normalizeVoucherQuestion,
  timingSafeEqualStrings,
} from "../utils/crypto.js";

const SETTINGS_ID = "default";

export function hasVoucherChallenge(settings) {
  return Boolean(settings?.voucherQuestion && settings?.answerSalt && settings?.answerHash);
}

export function isCampaignConfigured(settings) {
  return Boolean(settings?.voucherCode) && hasVoucherChallenge(settings);
}

/**
 * Ensures the singleton campaign settings document exists and reconciles issuedCount
 * with persisted vouchers on startup.
 */
export async function initializeCampaign(initialLimit = config.defaultLimit) {
  const settings = await CampaignSettings.findOneAndUpdate(
    { _id: SETTINGS_ID },
    {
      $setOnInsert: {
        _id: SETTINGS_ID,
        maxVouchers: initialLimit,
        issuedCount: 0,
        startedAt: new Date(),
        voucherCode: "",
        voucherQuestion: "",
        answerSalt: "",
        answerHash: "",
      },
    },
    { upsert: true, new: true },
  );

  const actualCount = await Voucher.countDocuments();
  if (settings.issuedCount !== actualCount) {
    settings.issuedCount = actualCount;
    await settings.save();
  }
  return settings;
}

async function getSettingsOrInitialize() {
  const settings = await CampaignSettings.findById(SETTINGS_ID).lean();
  if (settings) return settings;
  return (await initializeCampaign()).toObject();
}

export async function getCampaignStatus() {
  const settings = await getSettingsOrInitialize();
  const issued = settings.issuedCount;
  return {
    limit: settings.maxVouchers,
    issued,
    remaining: Math.max(0, settings.maxVouchers - issued),
    available: issued < settings.maxVouchers,
    challengeConfigured: isCampaignConfigured(settings),
  };
}

function assertClaimEligibility(settings, code) {
  if (settings.issuedCount >= settings.maxVouchers) {
    throw new VoucherError(409, "unavailable", "this voucher is no longer available");
  }
  if (!isCampaignConfigured(settings)) {
    throw new VoucherError(
      409,
      "not_configured",
      "Voucher claims are not open yet. Please check back soon.",
    );
  }
  if (!timingSafeEqualStrings(code, settings.voucherCode)) {
    throw new VoucherError(
      400,
      "invalid_code",
      "That voucher code doesn't match. Please check it and try again.",
    );
  }
}

export async function getVoucherQuestion(rawCode) {
  const code = normalizeVoucherCode(rawCode);
  const settings = await getSettingsOrInitialize();
  assertClaimEligibility(settings, code);
  return settings.voucherQuestion;
}

export async function createVoucher(rawCode, rawAnswer, hashIterations = config.answerHashIterations) {
  const code = normalizeVoucherCode(rawCode);
  const answer = normalizeVoucherAnswer(rawAnswer);

  const settings = await getSettingsOrInitialize();
  assertClaimEligibility(settings, code);

  const candidateHash = hashVoucherAnswer(answer, settings.answerSalt, hashIterations);
  if (!timingSafeEqualStrings(candidateHash, settings.answerHash)) {
    throw new VoucherError(400, "incorrect_answer", "That answer isn't correct. Please try again.");
  }

  // Single-document conditional increment enforces the campaign quota atomically in MongoDB.
  const reserved = await CampaignSettings.findOneAndUpdate(
    {
      _id: SETTINGS_ID,
      voucherCode: settings.voucherCode,
      answerSalt: settings.answerSalt,
      answerHash: settings.answerHash,
      $expr: { $lt: ["$issuedCount", "$maxVouchers"] },
    },
    { $inc: { issuedCount: 1 } },
    { new: true },
  );

  if (!reserved) {
    const latest = await getSettingsOrInitialize();
    assertClaimEligibility(latest, code);
    throw new VoucherError(
      400,
      "incorrect_answer",
      "That answer isn't correct. Please try again.",
    );
  }

  try {
    const createdAt = new Date();
    const voucher = await Voucher.create({
      code: reserved.voucherCode,
      createdAt,
    });
    return {
      id: voucher._id.toString(),
      code,
      createdAt: voucher.createdAt.toISOString(),
    };
  } catch (error) {
    // Compensate the reserved slot if voucher document creation fails.
    await CampaignSettings.updateOne(
      { _id: SETTINGS_ID, issuedCount: { $gt: 0 } },
      { $inc: { issuedCount: -1 } },
    );
    throw error;
  }
}

export async function updateVoucherCode(rawCode) {
  const code = normalizeVoucherCode(rawCode);
  await getSettingsOrInitialize();
  await CampaignSettings.updateOne({ _id: SETTINGS_ID }, { $set: { voucherCode: code } });
  return code;
}

export async function updateVoucherChallenge(
  rawQuestion,
  rawAnswer,
  hashIterations = config.answerHashIterations,
) {
  const question = normalizeVoucherQuestion(rawQuestion);
  const keepExistingAnswer = rawAnswer === undefined || rawAnswer === null || rawAnswer === "";
  const answer = keepExistingAnswer ? null : normalizeVoucherAnswer(rawAnswer);
  const settings = await getSettingsOrInitialize();

  if (keepExistingAnswer) {
    if (!settings.answerSalt || !settings.answerHash) {
      throw new VoucherError(400, "invalid_answer", "Enter an answer.");
    }
    await CampaignSettings.updateOne(
      { _id: SETTINGS_ID },
      { $set: { voucherQuestion: question } },
    );
  } else {
    const salt = crypto.randomBytes(16).toString("hex");
    const answerHash = hashVoucherAnswer(answer, salt, hashIterations);
    await CampaignSettings.updateOne(
      { _id: SETTINGS_ID },
      { $set: { voucherQuestion: question, answerSalt: salt, answerHash } },
    );
  }
  return question;
}

export async function updateLimit(value) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > config.maxLimit
  ) {
    throw new VoucherError(
      400,
      "invalid_limit",
      `Choose a limit between 1 and ${config.maxLimit.toLocaleString("en-US")}.`,
    );
  }

  await getSettingsOrInitialize();
  const updated = await CampaignSettings.findOneAndUpdate(
    {
      _id: SETTINGS_ID,
      $expr: { $lte: ["$issuedCount", value] },
    },
    { $set: { maxVouchers: value } },
    { new: true },
  );

  if (!updated) {
    throw new VoucherError(
      409,
      "limit_below_issued",
      "The limit cannot be lower than the number of vouchers already created.",
    );
  }
  return getCampaignStatus();
}

export async function getAdminDashboard() {
  const settings = await getSettingsOrInitialize();
  const [first, last, recent] = await Promise.all([
    Voucher.findOne().sort({ _id: 1 }).select("createdAt").lean(),
    Voucher.findOne().sort({ _id: -1 }).select("createdAt").lean(),
    Voucher.find().sort({ _id: -1 }).limit(8).select("code createdAt").lean(),
  ]);

  const issued = settings.issuedCount;
  const nowMs = Date.now();
  const firstMs = first ? new Date(first.createdAt).getTime() : null;
  const lastMs = last ? new Date(last.createdAt).getTime() : null;
  const startedMs = new Date(settings.startedAt).getTime();
  const soldOut = issued >= settings.maxVouchers;

  const elapsedReferenceMs = soldOut ? startedMs : firstMs ?? startedMs;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - elapsedReferenceMs) / 1000));
  const timeToFillSeconds =
    soldOut && lastMs !== null ? Math.max(0, Math.floor((lastMs - startedMs) / 1000)) : null;
  const activeSeconds =
    firstMs !== null && lastMs !== null ? Math.max(0, Math.floor((lastMs - firstMs) / 1000)) : 0;
  const averagePerHour = activeSeconds
    ? Math.round(((Math.max(0, issued - 1) * 3600) / activeSeconds) * 10) / 10
    : 0;

  return {
    limit: settings.maxVouchers,
    voucherCode: settings.voucherCode,
    voucherQuestion: settings.voucherQuestion,
    questionConfigured: hasVoucherChallenge(settings),
    challengeConfigured: isCampaignConfigured(settings),
    issued,
    remaining: Math.max(0, settings.maxVouchers - issued),
    available: !soldOut,
    startedAt: new Date(settings.startedAt).toISOString(),
    elapsedSeconds,
    timeToFillSeconds,
    averagePerHour,
    recent: recent.map((voucher) => ({
      code: voucher.code,
      createdAt: new Date(voucher.createdAt).toISOString(),
    })),
  };
}

