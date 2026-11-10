import { AppError } from "../../../utils/app-error.js";

export interface ZinipayCreateSessionParams {
  amount: number;
  invoiceNumber: string;
  workspaceId: string;
  planCode: string;
  userId: string;
  userName?: string;
  userEmail?: string;
  redirectUrl?: string;
  cancelUrl?: string;
  webhookUrl?: string;
}

export interface ZinipayCreateSessionResult {
  paymentUrl: string;
  invoiceId: string;
  rawResponse?: any;
}

export interface ZinipayVerifyResult {
  status: "COMPLETED" | "PENDING" | "FAILED";
  invoice_id: string;
  transaction_id?: string;
  amount?: number;
  payment_method?: string;
  customerName?: string;
  customerEmail?: string;
  message?: string;
  rawResponse?: any;
}

export class ZinipayGatewayService {
  private getBaseUrl(): string {
    const rawUrl =
      process.env.ZINIPAY_BASE_URL ||
      process.env.ZINIPAY_API_URL ||
      "https://api.zinipay.com";
    return rawUrl.trim().replace(/\/+$/, "");
  }

  private getApiKey(): string {
    const key = (process.env.ZINIPAY_API_KEY || "").trim();
    if (!key) {
      throw new AppError(
        "ZiniPay API Key not configured in environment (ZINIPAY_API_KEY is missing)",
        500,
      );
    }
    return key;
  }

  /**
   * Creates a hosted payment checkout session on ZiniPay.
   * Calls POST /v1/payment/create and returns the payment_url.
   */
  async createPaymentSession(
    params: ZinipayCreateSessionParams,
  ): Promise<ZinipayCreateSessionResult> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();

    const redirectUrl =
      params.redirectUrl ||
      process.env.ZINIPAY_SUCCESS_URL ||
      "http://localhost:5000/api/billing/gateways/zinipay/callback";

    const cancelUrl =
      params.cancelUrl ||
      process.env.ZINIPAY_CANCEL_URL ||
      `${process.env.CLIENT_URL || "http://localhost:3000"}/billing?payment_status=cancelled`;

    const payload: Record<string, any> = {
      amount: params.amount,
      redirect_url: redirectUrl,
      cancel_url: cancelUrl,
      cus_name: params.userName || "Customer",
      cus_email: params.userEmail || "billing@vexchat.app",
      metadata: {
        invoice_number: params.invoiceNumber,
        workspace_id: params.workspaceId,
        plan_code: params.planCode,
        user_id: params.userId,
      },
    };

    if (params.webhookUrl) {
      payload.webhook_url = params.webhookUrl;
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/payment/create`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "zinipay-api-key": apiKey,
          "zini-api-key": apiKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (networkErr: any) {
      throw new AppError(
        `Failed to reach ZiniPay gateway: ${networkErr?.message || "Network error"}`,
        502,
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new AppError(
        `ZiniPay returned an unparseable response with status: ${response.status}`,
        502,
      );
    }

    const isSuccess =
      data.status === true ||
      data.status === "true" ||
      data.status === "SUCCESS" ||
      Boolean(data.payment_url || data.url);

    const paymentUrl =
      data.payment_url ||
      data.paymentUrl ||
      data.url ||
      data.data?.payment_url;

    if (!response.ok || !isSuccess || !paymentUrl) {
      const errMsg =
        data.message ||
        data.error ||
        data.errorMessage ||
        `HTTP ${response.status} from ZiniPay`;
      throw new AppError(`ZiniPay Session Creation Failed: ${errMsg}`, 502);
    }

    // Extract invoice_id from response or fallback to the trailing URL segment
    const invoiceId =
      data.invoice_id ||
      data.invoiceId ||
      data.data?.invoice_id ||
      paymentUrl.split("/").filter(Boolean).pop() ||
      params.invoiceNumber;

    return {
      paymentUrl,
      invoiceId,
      rawResponse: data,
    };
  }

  /**
   * Verifies the authenticity and completion status of an invoice directly with ZiniPay.
   * Calls POST /v1/payment/verify.
   */
  async verifyPayment(invoiceId: string): Promise<ZinipayVerifyResult> {
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();

    if (!invoiceId || typeof invoiceId !== "string") {
      throw new AppError("A valid ZiniPay invoice_id is required for verification", 400);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/payment/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "zinipay-api-key": apiKey,
          "zini-api-key": apiKey,
        },
        body: JSON.stringify({ invoice_id: invoiceId }),
      });
    } catch (networkErr: any) {
      throw new AppError(
        `Failed to verify payment with ZiniPay: ${networkErr?.message || "Network error"}`,
        502,
      );
    }

    let data: any;
    try {
      data = await response.json();
    } catch {
      throw new AppError(
        `ZiniPay verify returned an invalid response with status: ${response.status}`,
        502,
      );
    }

    // Normalize raw status
    const rawStatus = (
      data.status ||
      data.payment_status ||
      data.transactionStatus ||
      ""
    )
      .toString()
      .toUpperCase();

    let normalizedStatus: "COMPLETED" | "PENDING" | "FAILED" = "FAILED";
    if (
      rawStatus === "COMPLETED" ||
      rawStatus === "PAID" ||
      rawStatus === "SUCCESS" ||
      data.status === true
    ) {
      normalizedStatus = "COMPLETED";
    } else if (rawStatus === "PENDING" || rawStatus === "PROCESSING") {
      normalizedStatus = "PENDING";
    } else {
      normalizedStatus = "FAILED";
    }

    return {
      status: normalizedStatus,
      invoice_id: data.invoice_id || invoiceId,
      transaction_id: data.transaction_id || data.trxID || data.txID,
      amount: typeof data.amount === "number" ? data.amount : Number(data.amount) || undefined,
      payment_method: data.payment_method || data.paymentMethod || data.method,
      customerName: data.cus_name || data.customerName,
      customerEmail: data.cus_email || data.customerEmail,
      message: data.message,
      rawResponse: data,
    };
  }
}

export const zinipayGatewayService = new ZinipayGatewayService();
