/**
 * VexChat Billing Configuration & Authoritative Plan Catalog
 * All pricing is denominated in BDT with a strictly monthly billing cycle.
 */

export const CURRENCY = "BDT" as const;
export const BILLING_CYCLE = "MONTHLY" as const;

export type PlanCode = "STARTER" | "BUSINESS_PRO" | "ENTERPRISE";

export interface PlanDefinition {
  code: PlanCode;
  name: string;
  priceBdt: number;
  description: string;
  limits: {
    maxWhatsAppNumbers: number; // -1 for unlimited
    maxTeamMembers: number; // -1 for unlimited
  };
  features: string[];
}

export const BILLING_PLANS: Record<PlanCode, PlanDefinition> = {
  STARTER: {
    code: "STARTER",
    name: "Starter",
    priceBdt: 3000,
    description: "Ideal for small businesses starting with WhatsApp Business API.",
    limits: {
      maxWhatsAppNumbers: 1,
      maxTeamMembers: 3,
    },
    features: [
      "1 Connected WhatsApp Business Number",
      "Up to 3 Team Members",
      "Unified Team Inbox",
      "Standard Message Templates",
      "Basic Analytics",
      "Community & Email Support",
    ],
  },
  BUSINESS_PRO: {
    code: "BUSINESS_PRO",
    name: "Business Pro",
    priceBdt: 7400,
    description: "Designed for growing teams needing advanced messaging, automation, and team collaboration.",
    limits: {
      maxWhatsAppNumbers: 2,
      maxTeamMembers: 10,
    },
    features: [
      "2 Connected WhatsApp Business Numbers",
      "Up to 10 Team Members",
      "Advanced Multi-Agent Chat Routing",
      "Broadcast Campaigns & Analytics",
      "Full Template Manager",
      "Priority Email & Chat Support",
    ],
  },
  ENTERPRISE: {
    code: "ENTERPRISE",
    name: "Enterprise",
    priceBdt: 18600,
    description: "Full-scale solution for high-volume enterprises with unlimited scale and dedicated support.",
    limits: {
      maxWhatsAppNumbers: -1, // Unlimited
      maxTeamMembers: -1, // Unlimited
    },
    features: [
      "Unlimited Connected WhatsApp Numbers",
      "Unlimited Team Members",
      "Unlimited Broadcast Campaigns",
      "Dedicated Account Manager",
      "Custom SLA & 24/7 Phone Support",
      "Custom Integrations & Webhook Ingress",
    ],
  },
};

export const PAYMENT_METHODS = [
  "BKASH",
  "CITY_BANK_CARD",
  "CITY_BANK_TRANSFER",
] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = [
  "INITIATED",
  "PENDING_VERIFICATION",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "REFUNDED",
] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = [
  "ACTIVE",
  "EXPIRED",
  "CANCELLED",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const INVOICE_STATUSES = [
  "PAID",
  "PENDING",
  "VOID",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Returns number of days in a given UTC month (0 = Jan, 1 = Feb, ..., 11 = Dec).
 */
export function getDaysInUTCMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Calendar-month addition helper with billing anchor day preservation.
 * Operates purely in UTC and preserves the customer's anchor day (e.g. 31st).
 *
 * Example:
 * Jan 31 (anchor 31) -> Feb 28 (or 29) -> Mar 31 -> Apr 30 -> May 31.
 */
export function addCalendarMonth(baseDate: Date, anchorDay?: number): Date {
  const effectiveAnchor =
    typeof anchorDay === "number" && anchorDay >= 1 && anchorDay <= 31
      ? anchorDay
      : baseDate.getUTCDate();

  const currentYear = baseDate.getUTCFullYear();
  const currentMonth = baseDate.getUTCMonth();

  const targetYear = currentMonth === 11 ? currentYear + 1 : currentYear;
  const targetMonth = (currentMonth + 1) % 12;

  const daysInTargetMonth = getDaysInUTCMonth(targetYear, targetMonth);
  const targetDay = Math.min(effectiveAnchor, daysInTargetMonth);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      targetDay,
      baseDate.getUTCHours(),
      baseDate.getUTCMinutes(),
      baseDate.getUTCSeconds(),
      baseDate.getUTCMilliseconds(),
    ),
  );
}

/**
 * Calculates new subscription period based on business rules:
 * - If current subscription is ACTIVE and not expired (currentPeriodEnd > now):
 *   Period starts at currentPeriodEnd and extends by 1 calendar month using existing anchor day (early renewal preservation).
 * - If subscription is missing, expired, or cancelled:
 *   Period starts at referenceDate (defaults to now) and establishes a new anchor day.
 */
export function calculateSubscriptionPeriod(
  currentPeriodEnd?: Date | null,
  existingAnchorDay?: number | null,
  referenceDate: Date = new Date(),
): { periodStart: Date; periodEnd: Date; anchorDay: number } {
  const now = referenceDate;

  if (currentPeriodEnd && currentPeriodEnd.getTime() > now.getTime()) {
    // Active subscription: preserve remaining duration and preserve existing anchor day
    const periodStart = new Date(currentPeriodEnd.getTime());
    const anchorDay =
      typeof existingAnchorDay === "number" &&
      existingAnchorDay >= 1 &&
      existingAnchorDay <= 31
        ? existingAnchorDay
        : periodStart.getUTCDate();

    const periodEnd = addCalendarMonth(periodStart, anchorDay);
    return { periodStart, periodEnd, anchorDay };
  }

  // New or expired subscription: restart from referenceDate (or now) and establish anchor
  const periodStart = new Date(now.getTime());
  const anchorDay = periodStart.getUTCDate();
  const periodEnd = addCalendarMonth(periodStart, anchorDay);
  return { periodStart, periodEnd, anchorDay };
}
