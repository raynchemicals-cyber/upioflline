import mongoose from 'mongoose';
import { Account } from '../models/Account.js';
import { Transaction } from '../models/Transaction.js';
import { supportsTransactions } from '../config/db.js';

export class SettlementService {
  /**
   * Settles a payment instruction atomically.
   *
   * @param {object} instruction { senderVpa, receiverVpa, amount, signedAt, nonce }
   * @param {string} packetHash SHA-256 hex digest of ciphertext
   * @param {string} bridgeNodeId
   * @param {number} hopCount
   * @returns {Promise<object>} Settled or existing Transaction document
   */
  async settle(instruction, packetHash, bridgeNodeId, hopCount) {
    const sender = await Account.findOne({ vpa: instruction.senderVpa });
    if (!sender) {
      throw new Error(`Unknown sender VPA: ${instruction.senderVpa}`);
    }

    const receiver = await Account.findOne({ vpa: instruction.receiverVpa });
    if (!receiver) {
      throw new Error(`Unknown receiver VPA: ${instruction.receiverVpa}`);
    }

    const amount = Number(instruction.amount);
    if (isNaN(amount) || amount <= 0) {
      throw new Error('Amount must be positive');
    }

    // Check if this packet has already been settled (idempotency check at DB level)
    const existingTx = await Transaction.findOne({ packetHash });
    if (existingTx) {
      return existingTx;
    }

    // Insufficient funds check
    if (sender.balance < amount) {
      console.warn(
        `Insufficient balance: ${sender.vpa} has ₹${sender.balance}, tried to send ₹${amount}`
      );
      return this.recordRejected(instruction, packetHash, bridgeNodeId, hopCount);
    }

    // Check if replica set transactions are supported by deployment
    const useTransaction = supportsTransactions();

    if (useTransaction) {
      const session = await mongoose.startSession();
      try {
        session.startTransaction();

        // Atomic debit with condition
        const debitedSender = await Account.findOneAndUpdate(
          { vpa: instruction.senderVpa, balance: { $gte: amount } },
          { $inc: { balance: -amount, version: 1 } },
          { session, new: true }
        );

        if (!debitedSender) {
          await session.abortTransaction();
          return this.recordRejected(instruction, packetHash, bridgeNodeId, hopCount);
        }

        // Credit receiver
        await Account.findOneAndUpdate(
          { vpa: instruction.receiverVpa },
          { $inc: { balance: amount, version: 1 } },
          { session, new: true }
        );

        // Record transaction
        const [tx] = await Transaction.create(
          [
            {
              packetHash,
              senderVpa: instruction.senderVpa,
              receiverVpa: instruction.receiverVpa,
              amount,
              signedAt: new Date(instruction.signedAt),
              settledAt: new Date(),
              bridgeNodeId,
              hopCount,
              status: 'SETTLED',
            },
          ],
          { session }
        );

        await session.commitTransaction();
        return tx;
      } catch (err) {
        await session.abortTransaction().catch(() => {});
        if (err.code === 11000) {
          const duplicateTx = await Transaction.findOne({ packetHash });
          if (duplicateTx) return duplicateTx;
        }
        throw err;
      } finally {
        await session.endSession().catch(() => {});
      }
    }

    // Standalone fallback (atomic conditional updates)
    try {
      // Step 1: Pre-create transaction or catch duplicate
      const tx = new Transaction({
        packetHash,
        senderVpa: instruction.senderVpa,
        receiverVpa: instruction.receiverVpa,
        amount,
        signedAt: new Date(instruction.signedAt),
        settledAt: new Date(),
        bridgeNodeId,
        hopCount,
        status: 'SETTLED',
      });
      await tx.save();

      // Step 2: Debit sender atomically
      const debitedSender = await Account.findOneAndUpdate(
        { vpa: instruction.senderVpa, balance: { $gte: amount } },
        { $inc: { balance: -amount, version: 1 } },
        { new: true }
      );

      if (!debitedSender) {
        // Revert transaction status to REJECTED
        tx.status = 'REJECTED';
        await tx.save();
        return tx;
      }

      // Step 3: Credit receiver atomically
      await Account.findOneAndUpdate(
        { vpa: instruction.receiverVpa },
        { $inc: { balance: amount, version: 1 } },
        { new: true }
      );

      return tx;
    } catch (err) {
      if (err.code === 11000) {
        // Unique packetHash index prevented duplicate settlement
        const duplicateTx = await Transaction.findOne({ packetHash });
        if (duplicateTx) return duplicateTx;
      }
      throw err;
    }
  }

  async recordRejected(instruction, packetHash, bridgeNodeId, hopCount) {
    try {
      const tx = new Transaction({
        packetHash,
        senderVpa: instruction.senderVpa,
        receiverVpa: instruction.receiverVpa,
        amount: Number(instruction.amount),
        signedAt: new Date(instruction.signedAt),
        settledAt: new Date(),
        bridgeNodeId,
        hopCount,
        status: 'REJECTED',
      });
      return await tx.save();
    } catch (err) {
      if (err.code === 11000) {
        return await Transaction.findOne({ packetHash });
      }
      throw err;
    }
  }
}

export const settlementService = new SettlementService();
