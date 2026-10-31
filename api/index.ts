import "dotenv/config";

import app from "../src/app.js";
import connectDatabase from "../src/config/database.js";

export default async function handler(req: any, res: any) {
  try {
    await connectDatabase();

    return app(req, res);
  } catch (error) {
    console.error("Database connection failed:", error);

    return res.status(500).json({
      success: false,
      message: "Database connection failed",
    });
  }
}
