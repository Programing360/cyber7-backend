import "dotenv/config";

import app from "../src/app.js";
import connectDatabase from "../src/config/database.js";
import { loadCampaignEnv } from "../src/config/env.js";

export async function initializeApi(
  validateEnvironment: () => unknown = loadCampaignEnv,
  connect: () => Promise<void> = connectDatabase,
): Promise<void> {
  validateEnvironment();

  await connect();
}

export default async function handler(req: any, res: any) {
  try {
    await initializeApi();

    return app(req, res);
  } catch (error) {
    console.error("API initialization failed:", error);

    return res.status(500).json({
      success: false,
      message: "API initialization failed",
    });
  }
}
