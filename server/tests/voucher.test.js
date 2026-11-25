import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { VoucherError } from "../src/errors.js";
import { CampaignSettings } from "../src/models/CampaignSettings.js";
import { Voucher } from "../src/models/Voucher.js";
import {
  createVoucher,
  getAdminDashboard,
  getCampaignStatus,
  getVoucherQuestion,
  initializeCampaign,
  updateLimit,
  updateVoucherChallenge,
  updateVoucherCode,
} from "../src/services/voucherService.js";

const SHARED_CODE = " GRAD/2026 🎓 ";
const QUESTION = "What year is the convocation?";
const ANSWER = "Class of 2026";
const TEST_ITERATIONS = 1000;

let mongoServer;

before(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

after(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

describe("Voucher service & MongoDB rules", () => {
  beforeEach(async () => {
    await CampaignSettings.deleteMany({});
    await Voucher.deleteMany({});
    await initializeCampaign(3);
    await updateVoucherCode(SHARED_CODE);
    await updateVoucherChallenge(QUESTION, ANSWER, TEST_ITERATIONS);
  });

  it("claim preserves admin-configured code exactly", async () => {
    const voucher = await createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS);
    assert.equal(voucher.code, SHARED_CODE);
    assert.deepEqual(await getCampaignStatus(), {
      limit: 3,
      issued: 1,
      remaining: 2,
      available: true,
      challengeConfigured: true,
    });
  });

  it("allows shared code to be claimed multiple times", async () => {
    const first = await createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS);
    const second = await createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS);
    assert.equal(first.code, second.code);
    assert.equal((await getCampaignStatus()).issued, 2);
  });

  it("rejects wrong voucher code", async () => {
    await assert.rejects(
      () => createVoucher("OTHER-CODE", ANSWER, TEST_ITERATIONS),
      (err) => err instanceof VoucherError && err.code === "invalid_code",
    );
  });

  it("allows admin to set arbitrary shared voucher code", async () => {
    const updated = await updateVoucherCode("  spring / 2026 🎓  ");
    assert.equal(updated, "  spring / 2026 🎓  ");
    assert.equal((await getAdminDashboard()).voucherCode, updated);
  });

  it("reveals question on valid code and never returns answer", async () => {
    const q = await getVoucherQuestion(SHARED_CODE);
    assert.equal(q, QUESTION);
    const dashboard = await getAdminDashboard();
    assert.equal("answer" in dashboard, false);
    assert.equal("answerHash" in dashboard, false);
    assert.equal("answerSalt" in dashboard, false);
  });

  it("does not create voucher on wrong answer", async () => {
    await assert.rejects(
      () => createVoucher(SHARED_CODE, "wrong answer", TEST_ITERATIONS),
      (err) => err instanceof VoucherError && err.code === "incorrect_answer",
    );
    assert.equal((await getCampaignStatus()).issued, 0);
  });

  it("ignores case and outer whitespace when matching answer", async () => {
    const voucher = await createVoucher(SHARED_CODE, "  cLASS OF 2026  ", TEST_ITERATIONS);
    assert.equal(voucher.code, SHARED_CODE);
  });

  it("allows admin to update question and answer", async () => {
    const nextQuestion = "Which faculty is celebrating?";
    await updateVoucherChallenge(nextQuestion, "Nursing", TEST_ITERATIONS);

    assert.equal(await getVoucherQuestion(SHARED_CODE), nextQuestion);
    await assert.rejects(
      () => createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS),
      (err) => err instanceof VoucherError && err.code === "incorrect_answer",
    );
    const claimed = await createVoucher(SHARED_CODE, "Nursing", TEST_ITERATIONS);
    assert.equal(claimed.code, SHARED_CODE);
  });

  it("requires question and answer configuration before claims open", async () => {
    await CampaignSettings.deleteMany({});
    await Voucher.deleteMany({});
    await initializeCampaign(3);
    await updateVoucherCode(SHARED_CODE);

    await assert.rejects(
      () => createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS),
      (err) => err instanceof VoucherError && err.code === "not_configured",
    );
    assert.equal((await getCampaignStatus()).challengeConfigured, false);
  });

  it("enforces global limit atomically across simultaneous requests", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () => createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS)),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    assert.equal(fulfilled.length, 3);
    assert.equal(rejected.length, 9);
    for (const item of rejected) {
      assert.equal(item.reason.code, "unavailable");
    }
    assert.equal((await getCampaignStatus()).issued, 3);
    assert.equal(await Voucher.countDocuments(), 3);
  });

  it("prevents lowering limit below already issued count", async () => {
    await createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS);
    await createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS);

    await assert.rejects(
      () => updateLimit(1),
      (err) => err instanceof VoucherError && err.code === "limit_below_issued",
    );
    assert.equal((await getCampaignStatus()).limit, 3);
  });

  it("tracks questionConfigured separately from challengeConfigured", async () => {
    await CampaignSettings.deleteMany({});
    await Voucher.deleteMany({});
    await initializeCampaign(3);
    await updateVoucherChallenge(QUESTION, ANSWER, TEST_ITERATIONS);

    const dashboard = await getAdminDashboard();
    assert.equal(dashboard.questionConfigured, true);
    assert.equal(dashboard.challengeConfigured, false);
    assert.equal(dashboard.voucherQuestion, QUESTION);
  });

  it("preserves existing answer when admin updates only the question", async () => {
    const updatedQuestion = "Which graduating class is celebrating?";
    await updateVoucherChallenge(updatedQuestion, "", TEST_ITERATIONS);

    assert.equal(await getVoucherQuestion(SHARED_CODE), updatedQuestion);
    await assert.rejects(
      () => createVoucher(SHARED_CODE, "wrong", TEST_ITERATIONS),
      (err) => err instanceof VoucherError && err.code === "incorrect_answer",
    );
    const voucher = await createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS);
    assert.equal(voucher.code, SHARED_CODE);
  });

  it("rejects blank answer when no answer has been configured yet", async () => {
    await CampaignSettings.deleteMany({});
    await Voucher.deleteMany({});
    await initializeCampaign(3);

    await assert.rejects(
      () => updateVoucherChallenge(QUESTION, "", TEST_ITERATIONS),
      (err) => err instanceof VoucherError && err.code === "invalid_answer",
    );
  });

  it("rejects wrong code and returns exact sold-out message when full", async () => {
    await assert.rejects(
      () => getVoucherQuestion("WRONG"),
      (err) => err instanceof VoucherError && err.code === "invalid_code",
    );

    for (let i = 0; i < 3; i += 1) {
      await createVoucher(SHARED_CODE, ANSWER, TEST_ITERATIONS);
    }

    await assert.rejects(
      () => getVoucherQuestion(SHARED_CODE),
      (err) =>
        err instanceof VoucherError &&
        err.code === "unavailable" &&
        err.message === "this voucher is no longer available",
    );
  });
});

describe("Express HTTP API, session auth, and CORS", () => {
  let server;
  let baseUrl;

  before(async () => {
    const testConfig = loadConfig({
      VOUCHER_ADMIN_PASSWORD: "test-admin-secret",
      VOUCHER_SESSION_SECRET: "test-session-secret-key",
      VOUCHER_HASH_ITERATIONS: String(TEST_ITERATIONS),
      CORS_ORIGIN: "https://vouch-frontend.vercel.app,http://localhost:5173",
      NODE_ENV: "production",
    });
    const app = createApp(testConfig);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const address = server.address();
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    await CampaignSettings.deleteMany({});
    await Voucher.deleteMany({});
    await initializeCampaign(2);
  });

  async function apiCall(method, path, payload, headers = {}) {
    const requestHeaders = { ...headers };
    let body;
    if (payload !== undefined) {
      requestHeaders["Content-Type"] = "application/json";
      body = JSON.stringify(payload);
    }
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: requestHeaders,
      body,
    });
    const data = await response.json();
    return { status: response.status, data, headers: response.headers };
  }

  it("runs complete admin setup and visitor claim flow with cookie auth", async () => {
    const health = await apiCall("GET", "/health");
    assert.equal(health.status, 200);
    assert.equal(health.data.ok, true);

    const unauth = await apiCall("GET", "/api/v1/admin/dashboard");
    assert.equal(unauth.status, 401);

    const badLogin = await apiCall("POST", "/api/v1/admin/session", { password: "wrong" });
    assert.equal(badLogin.status, 401);

    const login = await apiCall(
      "POST",
      "/api/v1/admin/session",
      { password: "test-admin-secret" },
      { "X-Forwarded-Proto": "https" },
    );
    assert.equal(login.status, 200);
    assert.equal(login.data.authenticated, true);
    assert.ok(login.data.token);

    const setCookie = login.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=None/i);
    assert.match(setCookie, /Secure/i);
    const cookie = setCookie.split(";", 1)[0];

    const setLimit = await apiCall("PUT", "/api/v1/admin/settings", { limit: 1 }, { Cookie: cookie });
    assert.equal(setLimit.status, 200);
    assert.equal(setLimit.data.limit, 1);

    const setCode = await apiCall(
      "PUT",
      "/api/v1/admin/voucher-code",
      { code: "NURSING-26" },
      { Cookie: cookie },
    );
    assert.equal(setCode.status, 200);
    assert.equal(setCode.data.voucherCode, "NURSING-26");

    const setChallenge = await apiCall(
      "PUT",
      "/api/v1/admin/voucher-challenge",
      { question: "What month is induction?", answer: "November" },
      { Cookie: cookie },
    );
    assert.equal(setChallenge.status, 200);
    assert.equal(setChallenge.data.voucherQuestion, "What month is induction?");
    assert.equal("answer" in setChallenge.data, false);

    const updateQuestionOnly = await apiCall(
      "PUT",
      "/api/v1/admin/voucher-challenge",
      { question: "Which month is the ceremony?", answer: "" },
      { Authorization: `Bearer ${login.data.token}` },
    );
    assert.equal(updateQuestionOnly.status, 200);
    assert.equal(updateQuestionOnly.data.voucherQuestion, "Which month is the ceremony?");

    const dashboard = await apiCall("GET", "/api/v1/admin/dashboard", undefined, { Cookie: cookie });
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.data.questionConfigured, true);
    assert.equal(dashboard.data.challengeConfigured, true);
    assert.equal("answer" in dashboard.data, false);

    const publicConfig = await apiCall("GET", "/api/v1/config");
    assert.equal(publicConfig.status, 200);
    assert.deepEqual(publicConfig.data, { available: true, challengeConfigured: true });

    const wrongCode = await apiCall("POST", "/api/v1/voucher-question", { code: "WRONG" });
    assert.equal(wrongCode.status, 400);
    assert.equal(wrongCode.data.error, "invalid_code");

    const qRes = await apiCall("POST", "/api/v1/voucher-question", { code: "NURSING-26" });
    assert.equal(qRes.status, 200);
    assert.deepEqual(qRes.data, { question: "Which month is the ceremony?" });

    const wrongAns = await apiCall("POST", "/api/v1/vouchers", {
      code: "NURSING-26",
      answer: "December",
    });
    assert.equal(wrongAns.status, 400);
    assert.equal(wrongAns.data.error, "incorrect_answer");

    const claim = await apiCall("POST", "/api/v1/vouchers", {
      code: "NURSING-26",
      answer: "  november ",
    });
    assert.equal(claim.status, 201);
    assert.equal(claim.data.voucher.code, "NURSING-26");

    const soldOut = await apiCall("POST", "/api/v1/voucher-question", { code: "NURSING-26" });
    assert.equal(soldOut.status, 409);
    assert.equal(soldOut.data.message, "this voucher is no longer available");

    const logout = await apiCall("DELETE", "/api/v1/admin/session", undefined, { Cookie: cookie });
    assert.equal(logout.status, 200);
    assert.equal(logout.data.authenticated, false);
  });

  it("handles CORS allowlist, 405 method not allowed, 404, and malformed JSON", async () => {
    const allowedPreflight = await fetch(`${baseUrl}/api/v1/config`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://vouch-frontend.vercel.app",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(
      allowedPreflight.headers.get("access-control-allow-origin"),
      "https://vouch-frontend.vercel.app",
    );
    assert.equal(allowedPreflight.headers.get("access-control-allow-credentials"), "true");

    const disallowedPreflight = await fetch(`${baseUrl}/api/v1/config`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    assert.equal(disallowedPreflight.headers.get("access-control-allow-origin"), null);

    const methodNotAllowed = await apiCall("PATCH", "/api/v1/config");
    assert.equal(methodNotAllowed.status, 405);

    const notFound = await apiCall("GET", "/api/v1/does-not-exist");
    assert.equal(notFound.status, 404);

    const badJsonResponse = await fetch(`${baseUrl}/api/v1/voucher-question`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json",
    });
    assert.equal(badJsonResponse.status, 400);
    const badJsonBody = await badJsonResponse.json();
    assert.equal(badJsonBody.error, "invalid_json");
  });
});

