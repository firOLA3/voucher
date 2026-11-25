import mongoose from "mongoose";

const campaignSettingsSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "default",
    },
    maxVouchers: {
      type: Number,
      required: true,
      min: 1,
      default: 100,
    },
    issuedCount: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    startedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    voucherCode: {
      type: String,
      default: "",
    },
    voucherQuestion: {
      type: String,
      default: "",
    },
    answerSalt: {
      type: String,
      default: "",
    },
    answerHash: {
      type: String,
      default: "",
    },
  },
  {
    collection: "campaign_settings",
    versionKey: false,
  },
);

export const CampaignSettings =
  mongoose.models.CampaignSettings ||
  mongoose.model("CampaignSettings", campaignSettingsSchema);

