import "dotenv/config";
import mongoose from "mongoose";
import connectDatabase from "../src/config/database.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import { decrypt } from "../src/utils/encryption.js";

async function main() {
  console.log("=== DB & WHATSAPP CONNECTION DIAGNOSIS ===");
  await connectDatabase();

  const db = mongoose.connection.db;
  console.log("Database name:", db?.databaseName);

  // Check Workspaces
  const workspaces = await Workspace.find().lean();
  console.log(`Found ${workspaces.length} workspaces:`);
  for (const ws of workspaces) {
    console.log(`  - Workspace ID: ${ws._id.toString()}, Name: ${ws.name}, Slug: ${ws.slug}`);
  }

  // Check WhatsApp accounts
  // Note: accessTokenEncrypted has select: false, so use +accessTokenEncrypted to check decryption
  const accounts = await WhatsAppAccount.find().select("+accessTokenEncrypted").lean();
  console.log(`Found ${accounts.length} WhatsApp accounts in MongoDB:`);

  for (const acc of accounts) {
    let canDecrypt = false;
    let decryptedLength = 0;
    try {
      if (acc.accessTokenEncrypted) {
        const token = decrypt(acc.accessTokenEncrypted);
        canDecrypt = Boolean(token && token.length > 0);
        decryptedLength = token.length;
      }
    } catch (e: any) {
      console.log(`  Decryption error for account ${acc._id}:`, e.message);
    }

    console.log(`  - Account ID: ${acc._id.toString()}`);
    console.log(`    Workspace ID: ${acc.workspaceId?.toString()}`);
    console.log(`    Business Name: ${acc.businessName}`);
    console.log(`    Business Account ID (WABA): ${acc.businessAccountId}`);
    console.log(`    Phone Number ID: ${acc.phoneNumberId}`);
    console.log(`    Display Phone: ${acc.displayPhoneNumber}`);
    console.log(`    Status: ${acc.status}`);
    console.log(`    Webhook Verified: ${acc.webhookVerified}`);
    console.log(`    Connected At: ${acc.connectedAt}`);
    console.log(`    Has Encrypted Token: ${Boolean(acc.accessTokenEncrypted)}`);
    console.log(`    Token Decryptable: ${canDecrypt} (length: ${decryptedLength})`);
  }

  // Check specific phoneNumberId from prompt: 1429122933618887
  const promptPhoneId = "1429122933618887";
  const matchingPhone = await WhatsAppAccount.findOne({ phoneNumberId: promptPhoneId }).select("+accessTokenEncrypted").lean();
  console.log(`\nLookup for prompt phoneNumberId "${promptPhoneId}":`);
  if (matchingPhone) {
    console.log("  MATCH FOUND!");
    console.log(`  Account ID: ${matchingPhone._id}`);
    console.log(`  Workspace ID: ${matchingPhone.workspaceId}`);
    console.log(`  Status: ${matchingPhone.status}`);
    console.log(`  Business Account ID: ${matchingPhone.businessAccountId}`);
  } else {
    console.log("  NO ACCOUNT FOUND with this phoneNumberId in MongoDB!");
  }

  // Check env TEST_PHONE_NUMBER_ID
  const envPhoneId = process.env.TEST_PHONE_NUMBER_ID;
  console.log(`\nEnv TEST_PHONE_NUMBER_ID configured: ${Boolean(envPhoneId)}`);
  if (envPhoneId) {
    console.log(`  Does env TEST_PHONE_NUMBER_ID match prompt ID (${promptPhoneId})? ${envPhoneId === promptPhoneId}`);
    console.log(`  Length of env TEST_PHONE_NUMBER_ID: ${envPhoneId.length}`);
  }

  await mongoose.disconnect();
  console.log("\nDisconnected from DB.");
}

main().catch((err) => {
  console.error("Diagnosis failed:", err);
  process.exit(1);
});
