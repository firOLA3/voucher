import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { config as defaultConfig } from "./config.js";
import { VoucherError } from "./errors.js";
import {
  createVoucher,
  getAdminDashboard,
  getCampaignStatus,
  getVoucherQuestion,
  updateLimit,
  updateVoucherChallenge,
  updateVoucherCode,
} from "./services/voucherService.js";
import { signSessionToken, timingSafeEqualStrings, verifySessionToken } from "./utils/crypto.js";

const SESSION_COOKIE_NAME = "voucher_admin";

function buildCorsOptions(runtimeConfig) {
  const allowlist = runtimeConfig.corsOrigins || [];
  return {
    credentials: true,
    methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    origin(origin, callback) {
      // Allow non-browser / same-origin requests without an Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = origin.replace(/\/+$/, "");
      if (allowlist.includes("*")) {
        callback(null, true);
        return;
      }
      if (allowlist.length > 0) {
        callback(null, allowlist.includes(normalized));
        return;
      }
      // In local development without explicit CORS_ORIGIN, reflect the dev origin.
      callback(null, !runtimeConfig.isProduction);
    },
  };
}

function shouldUseSecureCookie(req, runtimeConfig) {
  const raw = process.env.VOUCHER_COOKIE_SECURE;
  if (raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  const forwardedProto = (req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const isHttps = req.secure || forwardedProto === "https";
  return runtimeConfig.cookieSecure || isHttps;
}

function buildCookieOptions(req, runtimeConfig, includeMaxAge = true) {
  const secure = shouldUseSecureCookie(req, runtimeConfig);
  // Browsers reject SameSite=None over plain HTTP; fall back to Lax on non-HTTPS dev requests.
  const sameSite = runtimeConfig.cookieSameSite === "none" && !secure ? "lax" : runtimeConfig.cookieSameSite;
  const options = {
    httpOnly: true,
    path: "/",
    sameSite,
    secure,
  };
  if (includeMaxAge) {
    options.maxAge = runtimeConfig.sessionLifetimeSeconds * 1000;
  }
  return options;
}

function extractSessionToken(req) {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return "";
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function methodNotAllowed(req, res) {
  res.status(405).json({ error: "method_not_allowed", message: "Method not allowed." });
}

export function createApp(runtimeConfig = defaultConfig) {
  const app = express();
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  app.use(cors(buildCorsOptions(runtimeConfig)));
  app.use(cookieParser());
  app.use(express.json({ limit: "8kb", strict: true }));

  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError || err?.type === "entity.parse.failed" || err?.type === "entity.too.large") {
      res.status(400).json({ error: "invalid_json", message: "Please send a valid request." });
      return;
    }
    next(err);
  });

  const requireAdmin = (req, res, next) => {
    const token = extractSessionToken(req);
    if (!verifySessionToken(token, runtimeConfig.sessionSecret)) {
      res.status(401).json({ error: "unauthorized", message: "Please sign in again." });
      return;
    }
    next();
  };

  const requireObjectBody = (req, res, next) => {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      next(new VoucherError(400, "invalid_json", "Please send a valid request."));
      return;
    }
    next();
  };

  app.get(["/", "/health", "/api/v1/health"], (req, res) => {
    res.json({ ok: true, service: "voucher-api" });
  });

  app
    .route("/api/v1/config")
    .get(
      asyncRoute(async (req, res) => {
        const status = await getCampaignStatus();
        res.json({
          available: status.available,
          challengeConfigured: status.challengeConfigured,
        });
      }),
    )
    .all(methodNotAllowed);

  app
    .route("/api/v1/voucher-question")
    .post(
      requireObjectBody,
      asyncRoute(async (req, res) => {
        const question = await getVoucherQuestion(req.body.code);
        res.json({ question });
      }),
    )
    .all(methodNotAllowed);

  app
    .route("/api/v1/vouchers")
    .post(
      requireObjectBody,
      asyncRoute(async (req, res) => {
        const voucher = await createVoucher(
          req.body.code,
          req.body.answer,
          runtimeConfig.answerHashIterations,
        );
        res.status(201).json({ voucher });
      }),
    )
    .all(methodNotAllowed);

  app
    .route("/api/v1/admin/session")
    .post(
      requireObjectBody,
      (req, res) => {
        const { password } = req.body;
        if (typeof password !== "string" || !timingSafeEqualStrings(password, runtimeConfig.adminPassword)) {
          res.status(401).json({
            error: "invalid_credentials",
            message: "That password doesn't look right. Try again.",
          });
          return;
        }
        const token = signSessionToken(runtimeConfig.sessionSecret, runtimeConfig.sessionLifetimeSeconds);
        res.cookie(SESSION_COOKIE_NAME, token, buildCookieOptions(req, runtimeConfig, true));
        res.json({ authenticated: true, token });
      },
    )
    .delete((req, res) => {
      res.clearCookie(SESSION_COOKIE_NAME, buildCookieOptions(req, runtimeConfig, false));
      res.json({ authenticated: false });
    })
    .all(methodNotAllowed);

  app
    .route("/api/v1/admin/dashboard")
    .get(
      requireAdmin,
      asyncRoute(async (req, res) => {
        res.json(await getAdminDashboard());
      }),
    )
    .all(methodNotAllowed);

  app
    .route("/api/v1/admin/settings")
    .put(
      requireAdmin,
      requireObjectBody,
      asyncRoute(async (req, res) => {
        res.json(await updateLimit(req.body.limit));
      }),
    )
    .all(methodNotAllowed);

  app
    .route("/api/v1/admin/voucher-code")
    .put(
      requireAdmin,
      requireObjectBody,
      asyncRoute(async (req, res) => {
        const voucherCode = await updateVoucherCode(req.body.code);
        res.json({ voucherCode });
      }),
    )
    .all(methodNotAllowed);

  app
    .route("/api/v1/admin/voucher-challenge")
    .put(
      requireAdmin,
      requireObjectBody,
      asyncRoute(async (req, res) => {
        const voucherQuestion = await updateVoucherChallenge(
          req.body.question,
          req.body.answer,
          runtimeConfig.answerHashIterations,
        );
        res.json({ voucherQuestion });
      }),
    )
    .all(methodNotAllowed);

  app.use((req, res) => {
    res.status(404).json({ error: "not_found", message: "Not found." });
  });

  app.use((err, req, res, next) => {
    if (err instanceof VoucherError) {
      res.status(err.status).json({ error: err.code, message: err.message });
      return;
    }
    console.error(`${req.method} ${req.path} failed:`, err);
    res.status(500).json({
      error: "server_error",
      message: "Something went wrong. Please try again.",
    });
  });

  return app;
}

