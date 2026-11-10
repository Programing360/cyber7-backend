import { Router } from "express";
import { billingService } from "../billing.service.js";
import Payment from "../payment.model.js";
import { bkashGatewayService } from "./bkash.service.js";

// bKash Callback / Redirect Handler Route
const router = Router({ mergeParams: true });

router.all("/bkash/callback", async (req, res) => {
  const paymentID = (req.query.paymentID || req.body.paymentID) as string;
  const status = (req.query.status || req.body.status) as string;
  const frontendUrl = process.env.CLIENT_URL || "http://localhost:3000";

  try {
    if (!paymentID || status === "failure" || status === "cancel") {
      return res.redirect(`${frontendUrl}/billing?payment_status=failed`);
    }

    // Execute bKash transaction
    const executed = await bkashGatewayService.executePayment(paymentID);
    const payment = await Payment.findOne({
      "gatewayData.paymentID": paymentID,
    });

    if (!payment) {
      return res.redirect(`${frontendUrl}/billing?payment_status=not_found`);
    }

    // Complete subscription update atomically
    await billingService.completePaymentAtomic({
      paymentId: payment._id,
      completionData: {
        trxID: executed.trxID,
        paymentID: executed.paymentID,
        rawGatewayResponse: executed,
      },
      actor: { actorType: "SYSTEM", actorEmail: "bkash-webhook@vexchat.app" },
      notes: `bKash automated payment successful. TrxID: ${executed.trxID}`,
    });

    return res.redirect(
      `${frontendUrl}/billing?payment_status=success&invoice=${payment.invoiceNumber}`,
    );
  } catch (err) {
    console.error("[bKash Callback Error]", err);
    return res.redirect(`${frontendUrl}/billing?payment_status=error`);
  }
});

const bikashRouter = router;

export default bikashRouter;
