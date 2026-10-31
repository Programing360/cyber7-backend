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
              display_phone_number: "+1 (555) 211-5241",
              phone_number_id: "1429122933618887",
            },
            contacts: [
              {
                profile: {
                  name: "Test Customer",
                },
                wa_id: "8801700000000",
              },
            ],
            messages: [
              {
                from: "8801700000000",
                id: "wamid.cyber7test001",
                timestamp: "1793337600",
                type: "text",
                text: {
                  body: "Hello Cyber7, this is a test message.",
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
