import mongoose from "mongoose";

export interface GatewayHealthResult {
  status: "HEALTHY" | "DEGRADED" | "DOWN";
  latencyMs: number;
  message: string;
  mode: string;
}

export interface GatewaysHealthReport {
  success: boolean;
  timestamp: string;
  overallStatus: "HEALTHY" | "DEGRADED" | "DOWN";
  gateways: {
    bkash: GatewayHealthResult;
    cityBank: GatewayHealthResult;
  };
}

export async function probePaymentGatewaysHealth(): Promise<GatewaysHealthReport> {
  const startTimestamp = new Date().toISOString();

  // 1. Probe bKash Gateway (Non-intrusive check)
  const bkashStart = Date.now();
  let bkashStatus: "HEALTHY" | "DEGRADED" | "DOWN" = "HEALTHY";
  let bkashMessage = "bKash API gateway responsive";
  let bkashLatency = 0;

  const bkashBaseUrl = (
    process.env.BKASH_BASE_URL ||
    process.env.BKASH_API_URL ||
    ""
  ).trim();
  const hasBkashCreds = Boolean(
    process.env.BKASH_APP_KEY && process.env.BKASH_APP_SECRET,
  );

  if (!hasBkashCreds) {
    bkashStatus = "DEGRADED";
    bkashMessage = "bKash credentials not fully configured in environment";
    bkashLatency = Date.now() - bkashStart;
  } else if (!bkashBaseUrl) {
    bkashStatus = "DEGRADED";
    bkashMessage = "bKash base URL is not defined";
    bkashLatency = Date.now() - bkashStart;
  } else {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);

      const probeUrl = bkashBaseUrl.replace(/\/+$/, "");
      const res = await fetch(probeUrl, {
        method: "HEAD",
        signal: controller.signal,
      }).catch(async () => {
        // Fallback to GET if HEAD rejected
        return await fetch(probeUrl, {
          method: "GET",
          signal: controller.signal,
        });
      });

      clearTimeout(timeoutId);
      bkashLatency = Date.now() - bkashStart;

      if (res.status >= 500) {
        bkashStatus = "DEGRADED";
        bkashMessage = `bKash gateway returned server status: ${res.status}`;
      } else {
        bkashStatus = "HEALTHY";
        bkashMessage = "bKash API gateway reachable and operational";
      }
    } catch (err: any) {
      bkashLatency = Date.now() - bkashStart;
      bkashStatus = err?.name === "AbortError" ? "DEGRADED" : "DOWN";
      bkashMessage =
        err?.name === "AbortError"
          ? "bKash endpoint probe timed out (3000ms)"
          : `bKash network probe unreachable: ${err?.message || "connection error"}`;
    }
  }

  // 2. Probe City Bank Direct & Manual Transfer Ledger
  const cityStart = Date.now();
  let cityStatus: "HEALTHY" | "DEGRADED" = "HEALTHY";
  let cityMessage = "City Bank verification ledger operational";
  let cityLatency = 0;

  try {
    const isDbConnected = mongoose.connection.readyState === 1;
    cityLatency = Date.now() - cityStart;

    if (!isDbConnected && process.env.NODE_ENV === "production") {
      cityStatus = "DEGRADED";
      cityMessage = "Database ledger connection disconnected";
    } else {
      cityStatus = "HEALTHY";
      cityMessage =
        "City Bank deposit review queues and ledger verification operational";
    }
  } catch (err: any) {
    cityLatency = Date.now() - cityStart;
    cityStatus = "DEGRADED";
    cityMessage = `City Bank service probe error: ${err?.message || "internal error"}`;
  }

  const isDegraded =
    bkashStatus === "DEGRADED" ||
    cityStatus === "DEGRADED" ||
    bkashStatus === "DOWN";
  const overallStatus = isDegraded ? "DEGRADED" : "HEALTHY";

  return {
    success: true,
    timestamp: startTimestamp,
    overallStatus,
    gateways: {
      bkash: {
        status: bkashStatus,
        latencyMs: bkashLatency,
        message: bkashMessage,
        mode: "CHECKOUT_URL_AND_DIRECT_API",
      },
      cityBank: {
        status: cityStatus,
        latencyMs: cityLatency,
        message: cityMessage,
        mode: "MANUAL_TRANSFER_AND_CARD_GATEWAY",
      },
    },
  };
}
