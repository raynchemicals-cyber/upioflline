import mongoose from 'mongoose';

const relayNodeSchema = new mongoose.Schema(
  {
    nodeId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    reputation: {
      type: Number,
      default: 100, // 0 to 100
      min: 0,
      max: 100,
    },
    totalRelayed: {
      type: Number,
      default: 0,
    },
    invalidRelayed: {
      type: Number,
      default: 0,
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

export const RelayNode = mongoose.model('RelayNode', relayNodeSchema);
