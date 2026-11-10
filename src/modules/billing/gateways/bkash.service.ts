import { AppError } from "../../../utils/app-error.js";

export class BkashGatewayService {
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  private getBaseUrl(): string {
    // Production: https://tokenized.pay.bka.sh/v1.2.0-beta
    // Sandbox: https://tokenized.sandbox.bka.sh/v1.2.0-beta
    return (
      process.env.BKASH_BASE_URL ||
      "https://tokenized.sandbox.bka.sh/v1.2.0-beta"
    ).replace(/\/+$/, "");
  }

  async grantToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.tokenExpiresAt > now + 60000)
      return this.cachedToken!;

    const response = await fetch(
      `${this.getBaseUrl()}/tokenized/checkout/token/grant`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          username: process.env.BKASH_USERNAME!,
          password: process.env.BKASH_PASSWORD!,
        },
        body: JSON.stringify({
          app_key: process.env.BKASH_APP_KEY,
          app_secret: process.env.BKASH_APP_SECRET,
        }),
      },
    );

    const data: any = await response.json();
    if (data.statusCode !== "0000" || !data.id_token) {
      throw new AppError(
        `bKash Token Grant Failed: [${data.statusCode}] ${data.statusMessage}`,
        502,
      );
    }

    this.cachedToken = data.id_token;
    this.tokenExpiresAt = now + (Number(data.expires_in) || 3600) * 1000;
    return this.cachedToken!;
  }

  async createPayment(params: {
    amount: number;
    invoiceNumber: string;
  }): Promise<{ paymentID: string; redirectUrl: string }> {
    const token = await this.grantToken();
    const callbackURL =
      process.env.BKASH_CALLBACK_URL ||
      "http://localhost:5000/api/billing/gateways/bkash/callback";

    const response = await fetch(
      `${this.getBaseUrl()}/tokenized/checkout/create`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: token,
          "X-APP-Key": process.env.BKASH_APP_KEY!,
        },
        body: JSON.stringify({
          mode: "0011",
          payerReference: "VEXCHAT",
          callbackURL,
          amount: params.amount.toFixed(2),
          currency: "BDT",
          intent: "sale",
          merchantInvoiceNumber: params.invoiceNumber,
        }),
      },
    );

    const data: any = await response.json();
    if (data.statusCode !== "0000" || !data.paymentID || !data.bkashURL) {
      throw new AppError(
        `bKash Create Payment Failed: [${data.statusCode}] ${data.statusMessage}`,
        502,
      );
    }

    return { paymentID: data.paymentID, redirectUrl: data.bkashURL };
  }

  async executePayment(paymentID: string): Promise<any> {
    const token = await this.grantToken();
    const response = await fetch(
      `${this.getBaseUrl()}/tokenized/checkout/execute`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: token,
          "X-APP-Key": process.env.BKASH_APP_KEY!,
        },
        body: JSON.stringify({ paymentID }),
      },
    );

    const data: any = await response.json();
    if (data.statusCode !== "0000" || data.transactionStatus !== "Completed") {
      throw new AppError(
        `bKash Execution Failed: [${data.statusCode}] ${data.statusMessage}`,
        400,
      );
    }
    return data;
  }
}

export const bkashGatewayService = new BkashGatewayService();
