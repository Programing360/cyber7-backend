import mongoose from "mongoose";

const CONNECT_OPTIONS = {
  maxPoolSize: 10,
  minPoolSize: 0,
  maxIdleTimeMS: 60_000,
  serverSelectionTimeoutMS: 10_000,
  socketTimeoutMS: 45_000,
};

interface CachedConnection {
  uri: string;
  promise: Promise<typeof mongoose>;
  onDisconnected: () => void;
}

let cachedConnection: CachedConnection | null = null;

const removeDisconnectedHandler = (connection: CachedConnection): void => {
  mongoose.connection.off("disconnected", connection.onDisconnected);
};

const clearCachedConnection = (connection: CachedConnection): void => {
  if (cachedConnection !== connection) {
    return;
  }

  cachedConnection = null;
  removeDisconnectedHandler(connection);
};

const connectDatabase = async (): Promise<void> => {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    throw new Error("MONGODB_URI is missing from environment variables");
  }

  if (cachedConnection?.uri === mongoUri) {
    await cachedConnection.promise;
    return;
  }

  let connection!: CachedConnection;

  const onDisconnected = (): void => {
    if (cachedConnection === connection) {
      clearCachedConnection(connection);
      return;
    }

    removeDisconnectedHandler(connection);
  };

  const promise = mongoose.connect(mongoUri, CONNECT_OPTIONS).then(
    (result) => result,
    (error) => {
      clearCachedConnection(connection);
      throw error;
    },
  );

  connection = { uri: mongoUri, promise, onDisconnected };

  if (cachedConnection) {
    removeDisconnectedHandler(cachedConnection);
  }

  cachedConnection = connection;
  mongoose.connection.on("disconnected", onDisconnected);

  await promise;

  console.log("MongoDB connected successfully");
};

export default connectDatabase;
