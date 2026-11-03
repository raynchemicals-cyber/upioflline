import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

let mongoMemoryServer = null;

/**
 * Connect to MongoDB using MONGODB_URI, or fall back to an in-memory
 * MongoDB server for zero-setup local demo and testing.
 */
export async function connectDb(uri) {
  const targetUri = uri || process.env.MONGODB_URI;

  if (targetUri) {
    try {
      console.log(`Connecting to MongoDB at ${targetUri.replace(/:[^:@]+@/, ':***@')}...`);
      await mongoose.connect(targetUri);
      console.log('Connected to external MongoDB.');
      return mongoose.connection;
    } catch (err) {
      console.warn(`Could not connect to external MongoDB: ${err.message}. Falling back to in-memory MongoDB.`);
    }
  }

  // Fallback to in-memory MongoDB
  if (!mongoMemoryServer) {
    console.log('Starting in-memory MongoDB server...');
    mongoMemoryServer = await MongoMemoryServer.create();
  }
  const memUri = mongoMemoryServer.getUri();
  console.log(`Connected to in-memory MongoDB at ${memUri}`);
  await mongoose.connect(memUri);
  return mongoose.connection;
}

export function supportsTransactions() {
  const topology = mongoose.connection?.client?.topology;
  if (!topology) return false;
  const type = topology.description?.type;
  return type === 'ReplicaSetWithPrimary' || type === 'Sharded';
}

export async function disconnectDb() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }
  if (mongoMemoryServer) {
    await mongoMemoryServer.stop();
    mongoMemoryServer = null;
  }
}
