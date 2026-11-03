import "dotenv/config";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";

const appSecret = process.env.META_APP_SECRET;

if (!appSecret) {
  throw new Error("META_APP_SECRET is missing");
}

// Postman-এর Body-এর সঙ্গে এই payload হুবহু মিলতে হবে।
const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "1099992426162120",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: {
              display_phone_number: "+880 1570-266232",
              phone_number_id: "1157794877408926",
            },
            contacts: [
              {
                profile: {
                  name: "Test Customer",
                },
                wa_id: "1574720934077122",
              },
            ],
            messages: [
              {
                from: "8801700000000",
                id: "wamid.vexchattest001",
                timestamp: "1793337600",
                type: "text",
                text: {
                  body: "Hello VexChat, this is a test message.",
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

const rawBody = JSON.stringify(payload);

const signature =
  "sha256=" +
  createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

console.log("Generated payload length:", Buffer.byteLength(rawBody, "utf8"));
console.log("Generated signature length:", signature.length);
console.log("App secret available:", Boolean(appSecret));

console.log("Payload:");
console.log(rawBody);

console.log("\nSignature:");
console.log(signature);
