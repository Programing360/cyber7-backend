import "dotenv/config";
import mongoose from "mongoose";
import connectDatabase from "../src/config/database.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import { connectWhatsAppAccount } from "../src/modules/whatsapp/whatsapp.service.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";

async function main() {
  console.log("=== TESTING CONNECT WHATSAPP ACCOUNT ===");
  await connectDatabase();

  const workspace = await Workspace.findOne().lean();
  if (!workspace) {
    console.error("No workspace found!");
    process.exit(1);
  }

  const workspaceId = workspace._id.toString();
  console.log(`Using Workspace: ${workspace.name} (${workspaceId})`);

  const businessName = process.env.TEST_BUSINESS_NAME || "Cyber7 Test";
  const businessAccountId = process.env.TEST_WABA_ID;
  const phoneNumberId = process.env.TEST_PHONE_NUMBER_ID;
  const displayPhoneNumber = process.env.TEST_DISPLAY_PHONE || "+1 555-211-5241";
  const accessToken = process.env.TEST_ACCESS_TOKEN;

  if (!businessAccountId || !phoneNumberId || !accessToken) {
    console.error("Missing test credentials in .env");
    process.exit(1);
  }

  console.log("Calling connectWhatsAppAccount with verified Meta credentials...");
  try {
    const result = await connectWhatsAppAccount({
      workspaceId,
      input: {
        businessName,
        businessAccountId,
        phoneNumberId,
        displayPhoneNumber,
        accessToken,
      },
    });

    console.log("Successfully connected WhatsApp account!");
    console.log("Result:", {
      id: result.id,
      businessName: result.businessName,
      phoneNumberId: result.phoneNumberId,
      displayPhoneNumber: result.displayPhoneNumber,
      status: result.status,
      connectedAt: result.connectedAt,
    });
  } catch (err: any) {
    console.error("connectWhatsAppAccount failed with error:", err.message);
  }

  // Verify in MongoDB
  const saved = await WhatsAppAccount.findOne({ phoneNumberId }).lean();
  console.log("Account in MongoDB now:", Boolean(saved), "Status:", saved?.status);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

