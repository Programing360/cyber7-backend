// cyber7-backend/src/modules/admin-auth/admin-email-otp.service.ts
import crypto from "node:crypto";
import User from "../auth/user.model.js";
import { sendEmail } from "../../services/mail.service.js";

export class AdminEmailOtpService {
  /**
   * ৬ ডিজিটের ওটিপি তৈরি করে ডাটাবেজে রাখে এবং ইমেইলে পাঠায়
   */
  async generateAndSendOtp(
    userId: string,
  ): Promise<{ success: boolean; message?: string }> {
    // ⚠️ select("+adminEmailOtp") বাধ্যতামূলক
    const user = await User.findById(userId).select("+adminEmailOtp");
    if (!user) {
      return { success: false, message: "Admin user not found" };
    }

    // ১. ক্রিপ্টোগ্রাফিক হাই-সিকিউর ৬ ডিজিট সংখ্যা
    const rawOtp = crypto.randomInt(100000, 999999).toString();
    const codeHash = crypto.createHash("sha256").update(rawOtp).digest("hex");
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // ৫ মিনিট মেয়াদ

    user.adminEmailOtp = {
      codeHash,
      expiresAt,
      attempts: 0,
    };
    await user.save();

    // ২. ইমেইল টেমপ্লেট
    const htmlContent = `
      <div style="font-family: Arial, sans-serif; background-color: #0b0f19; color: #ffffff; padding: 30px; border-radius: 12px; max-width: 450px; margin: auto;">
        <h2 style="color: #88da1c; margin-bottom: 8px;">VexChat Admin Verification</h2>
        <p style="color: #94a3b8; font-size: 14px;">Use the following one-time code to complete your administrator sign-in:</p>
        <div style="background-color: #1e293b; padding: 16px; border-radius: 8px; text-align: center; margin: 24px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #88da1c; font-family: monospace;">
            ${rawOtp}
          </span>
        </div>
        <p style="color: #64748b; font-size: 12px;">This code is valid for 5 minutes. If you did not initiate this login request, please verify your account security immediately.</p>
      </div>
    `;

    const emailSent = await sendEmail({
      to: user.email,
      subject: `[VexChat Admin] Login Code: ${rawOtp}`,
      html: htmlContent,
    });

    if (!emailSent) {
      return {
        success: false,
        message: "Failed to dispatch email. Check SMTP credentials.",
      };
    }

    return { success: true };
  }

  /**
   * ওটিপি ভেরিফাই করে
   */
  async verifyOtp(
    userId: string,
    inputOtp: string,
  ): Promise<{ success: boolean; code?: string; message?: string }> {
    // ⚠️ select("+adminEmailOtp") বাধ্যতামূলক, নইলে MongoDB ফিল্ডটি আনবে না
    const user = await User.findById(userId).select("+adminEmailOtp");

    if (!user || !user.adminEmailOtp || !user.adminEmailOtp.codeHash) {
      return {
        success: false,
        code: "OTP_NOT_FOUND",
        message: "No active verification code found. Please request a new one.",
      };
    }

    // ৩ বারের বেশি ভুল ইনপুটে ওটিপি বাতিল
    if (user.adminEmailOtp.attempts >= 3) {
      user.adminEmailOtp = undefined;
      await user.save();
      return {
        success: false,
        code: "TOO_MANY_ATTEMPTS",
        message: "Too many incorrect attempts. Please request a new code.",
      };
    }

    // মেয়াদ চেক
    if (Date.now() > new Date(user.adminEmailOtp.expiresAt).getTime()) {
      user.adminEmailOtp = undefined;
      await user.save();
      return {
        success: false,
        code: "OTP_EXPIRED",
        message: "Verification code has expired.",
      };
    }

    // হ্যাশ যাচাই
    const inputHash = crypto
      .createHash("sha256")
      .update(inputOtp.trim())
      .digest("hex");

    if (inputHash !== user.adminEmailOtp.codeHash) {
      user.adminEmailOtp.attempts = (user.adminEmailOtp.attempts || 0) + 1;
      await user.save();
      return {
        success: false,
        code: "INVALID_OTP",
        message: "Incorrect verification code.",
      };
    }

    // ভেরিফিকেশন সফল — ওটিপি কনজিউম করা হলো
    user.adminEmailOtp = undefined;
    await user.save();

    return { success: true };
  }
}

export const adminEmailOtpService = new AdminEmailOtpService();
