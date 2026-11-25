import mongoose from "mongoose";

const voucherSchema = new mongoose.Schema(
  {
    code: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
  },
  {
    collection: "vouchers",
    versionKey: false,
  },
);

voucherSchema.index({ createdAt: -1 });

export const Voucher =
  mongoose.models.Voucher || mongoose.model("Voucher", voucherSchema);

