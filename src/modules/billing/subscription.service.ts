import type { ClientSession, Types } from "mongoose";
import { AppError } from "../../utils/app-error.js";
import {
  BILLING_CYCLE,
  BILLING_PLANS,
  CURRENCY,
  calculateSubscriptionPeriod,
  type PlanCode,
} from "./billing.config.js";
import Subscription, { type ISubscription } from "./subscription.model.js";

export interface ExtendSubscriptionParams {
  workspaceId: string | Types.ObjectId;
  planCode: PlanCode;
  paymentId?: Types.ObjectId;
  referenceDate?: Date;
}

export class SubscriptionService {
  /**
   * Retrieves the current workspace subscription and marks it EXPIRED if past currentPeriodEnd.
   */
  async getWorkspaceSubscription(
    workspaceId: string | Types.ObjectId,
  ): Promise<ISubscription | null> {
    const subscription = await Subscription.findOne({ workspaceId });
    if (!subscription) {
      return null;
    }

    // Lazy expiration status check
    const now = new Date();
    if (
      subscription.status === "ACTIVE" &&
      subscription.currentPeriodEnd.getTime() < now.getTime()
    ) {
      subscription.status = "EXPIRED";
      await subscription.save();
    }

    return subscription;
  }

  /**
   * Atomically extends or activates a workspace subscription.
   * If the current subscription is active, adds 1 calendar month starting from currentPeriodEnd,
   * preserving the billing cycle anchor day (e.g. 31st).
   * If the subscription is expired or newly created, starts from now (or referenceDate) and establishes a new anchor day.
   */
  async extendSubscriptionPeriod(
    params: ExtendSubscriptionParams,
    session?: ClientSession,
  ): Promise<ISubscription> {
    const { workspaceId, planCode, paymentId, referenceDate = new Date() } = params;

    const planDef = BILLING_PLANS[planCode];
    if (!planDef) {
      throw new AppError(`Invalid plan code: ${planCode}`, 400);
    }

    const subQuery = Subscription.findOne({ workspaceId });
    if (session) {
      subQuery.session(session);
    }
    let subscription = await subQuery;

    const currentPeriodEnd =
      subscription && subscription.status === "ACTIVE"
        ? subscription.currentPeriodEnd
        : null;

    // Preserve existing anchor day if active; fall back to UTC day of period start if missing
    const existingAnchorDay =
      subscription && subscription.status === "ACTIVE"
        ? subscription.billingCycleAnchorDay || subscription.currentPeriodStart?.getUTCDate()
        : null;

    const { periodStart, periodEnd, anchorDay } = calculateSubscriptionPeriod(
      currentPeriodEnd,
      existingAnchorDay,
      referenceDate,
    );

    const historyEntry = {
      periodStart,
      periodEnd,
      planCode,
      paymentId,
      extendedAt: new Date(),
    };

    if (subscription) {
      subscription.planCode = planCode;
      subscription.planName = planDef.name;
      subscription.status = "ACTIVE";
      subscription.price = planDef.priceBdt;
      subscription.currency = CURRENCY;
      subscription.billingCycle = BILLING_CYCLE;
      subscription.billingCycleAnchorDay = anchorDay;
      subscription.currentPeriodStart = periodStart;
      subscription.currentPeriodEnd = periodEnd;
      subscription.lastPaymentId = paymentId;
      subscription.limits = { ...planDef.limits };
      subscription.features = [...planDef.features];
      subscription.history.push(historyEntry);

      if (session) {
        await subscription.save({ session });
      } else {
        await subscription.save();
      }
      return subscription;
    }

    const newSubArray = await Subscription.create(
      [
        {
          workspaceId,
          planCode,
          planName: planDef.name,
          status: "ACTIVE",
          currency: CURRENCY,
          price: planDef.priceBdt,
          billingCycle: BILLING_CYCLE,
          billingCycleAnchorDay: anchorDay,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          lastPaymentId: paymentId,
          limits: { ...planDef.limits },
          features: [...planDef.features],
          history: [historyEntry],
        },
      ],
      session ? { session } : undefined,
    );

    return newSubArray[0];
  }
}

export const subscriptionService = new SubscriptionService();
