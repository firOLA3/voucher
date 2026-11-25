import mongoose from "mongoose";
import { createApp } from "./app.js";
import { config } from "./config.js";
import { initializeCampaign } from "./services/voucherService.js";

async function start() {
  if (!config.mongoUri) {
    console.error(
      "Missing MONGODB_URI environment variable. Set MONGODB_URI to your MongoDB connection string.",
    );
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);
  await initializeCampaign(config.defaultLimit);

  if (config.generatedAdminPassword) {
    console.log(
      `Generated admin password (set VOUCHER_ADMIN_PASSWORD to keep it): ${config.adminPassword}`,
    );
  }
  if (config.isProduction && config.corsOrigins.length === 0) {
    console.warn(
      "CORS_ORIGIN is not set in production; cross-origin browser requests will be blocked.",
    );
  }

  const app = createApp(config);
  const server = app.listen(config.port, config.host, () => {
    console.log(`Voucher API listening on http://${config.host}:${config.port}`);
  });

  const shutdown = async (signal) => {
    console.log(`Received ${signal}, shutting down gracefully...`);
    server.close(async () => {
      await mongoose.disconnect();
      process.exit(0);
    });
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});

