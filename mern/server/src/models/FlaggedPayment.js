import mongoose from 'mongoose';

const flaggedPaymentSchema = new mongoose.Schema(
  {
    packetId: {
      type: String,
      required: true,
    },
    packetHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    ciphertext: {
      type: String,
      required: true,
    },
    senderVpa: {
      type: String,
      required: true,
    },
    receiverVpa: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
    signedAt: {
      type: Date,
      required: true,
    },
    bridgeNodeId: {
      type: String,
      required: true,
    },
    hopCount: {
      type: Number,
      required: true,
    },
    riskScore: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    contributingFactors: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['PENDING_REVIEW', 'APPROVED', 'REJECTED'],
      default: 'PENDING_REVIEW',
      index: true,
    },
    reviewedAt: {
      type: Date,
    },
    reviewDecision: {
      type: String,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret.__v;
        return ret;
      },
    },
  }
);

export const FlaggedPayment = mongoose.model('FlaggedPayment', flaggedPaymentSchema);
