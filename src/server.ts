import "dotenv/config";

import app from "./app.js";
import connectDatabase from "./config/database.js";
import { loadCampaignEnv } from "./config/env.js";

const PORT = Number(process.env.PORT) || 5000;

const startServer = async (): Promise<void> => {
  try {
    loadCampaignEnv();
    await connectDatabase();

    app.listen(PORT, () => {
      console.log(`VexChat server running at http://localhost:${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/api/health`);
    });
  } catch (error) {
    console.error("Failed to start VexChat server:", error);
    process.exit(1);
  }
};

void startServer();
