import "dotenv/config";
import { createHmac } from "node:crypto";

const appSecret = process.env.META_APP_SECRET;

if (!appSecret) {
  throw new Error("META_APP_SECRET is missing");
}

const payload = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "123456789",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            messages: [
              {
                from: "8801700000000",
                id: "wamid.test123",
                timestamp: "1793337600",
                type: "text",
                text: {
                  body: "Hello Cyber7",
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
  "sha256=" + createHmac("sha256", appSecret).update(rawBody).digest("hex");

console.log("Payload:");
console.log(rawBody);

console.log("\nX-Hub-Signature-256:");
console.log(signature);
