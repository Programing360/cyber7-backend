import "dotenv/config";

import { server } from "./app.js";
import connectDatabase from "./config/database.js";
import { loadCampaignEnv } from "./config/env.js";

const PORT = Number(process.env.PORT) || 5000;

const startServer = async (): Promise<void> => {
  try {
    loadCampaignEnv();
    await connectDatabase();

    server.listen(PORT, () => {
    });
  } catch (error) {
    console.error("Failed to start VexChat server:", error);
    process.exit(1);
  }
};

void startServer();
