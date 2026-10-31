import "dotenv/config";
import mongoose from "mongoose";
import connectDatabase from "../src/config/database.js";
import User from "../src/modules/auth/user.model.js";
import Workspace from "../src/modules/workspace/workspace.model.js";
import Membership from "../src/modules/workspace/membership.model.js";
import WhatsAppAccount from "../src/modules/whatsapp/whatsapp.model.js";

async function run() {
  await connectDatabase();

  const users = await User.find().select("name email role").lean();
  console.log("Users:", users);

  const workspaces = await Workspace.find().lean();
  console.log("Workspaces:", workspaces.map((w: any) => ({ id: w._id, name: w.name, ownerId: w.ownerId })));

  const members = await Membership.find().lean();
  console.log("Members:", members.map((m: any) => ({ workspaceId: m.workspaceId, userId: m.userId, role: m.role })));

  const accounts = await WhatsAppAccount.find().lean();
  console.log("WhatsApp Accounts count:", accounts.length);
  if (accounts.length > 0) {
    console.log("Accounts:", accounts);
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
