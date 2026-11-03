import mongoose from 'mongoose';

const accountSchema = new mongoose.Schema(
  {
    vpa: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    holderName: {
      type: String,
      required: true,
      trim: true,
    },
    balance: {
      type: Number,
      required: true,
      min: 0,
    },
    version: {
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

export const Account = mongoose.model('Account', accountSchema);
