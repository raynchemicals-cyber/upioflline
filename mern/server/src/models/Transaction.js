import mongoose from 'mongoose';

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});
const Counter = mongoose.model('TransactionCounter', counterSchema);

const transactionSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true,
      index: true,
    },
    packetHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
      length: 64,
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
    settledAt: {
      type: Date,
      default: Date.now,
    },
    bridgeNodeId: {
      type: String,
      required: true,
    },
    hopCount: {
      type: Number,
      required: true,
    },
    status: {
      type: String,
      enum: ['SETTLED', 'REJECTED'],
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

transactionSchema.pre('save', async function (next) {
  if (this.isNew && this.id == null) {
    const counter = await Counter.findByIdAndUpdate(
      { _id: 'transactionId' },
      { $inc: { seq: 1 } },
      { new: true, upsert: true }
    );
    this.id = counter.seq;
  }
  next();
});

export const Transaction = mongoose.model('Transaction', transactionSchema);
