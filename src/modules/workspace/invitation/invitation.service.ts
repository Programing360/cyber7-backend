import { createHash, randomBytes } from "node:crypto";
import mongoose, { Types } from "mongoose";

import { AppError } from "../../../utils/app-error.js";

import { Invitation } from "./invitation.model.js";

import type { CreateInvitationInput } from "./invitation.validation.js";
import Workspace from "../workspace.model.js";
import User from "../../auth/user.model.js";
import Membership from "../membership.model.js";

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createInvitation(
  workspaceId: string,
  invitedBy: string,
  input: CreateInvitationInput,
) {
  if (
    !Types.ObjectId.isValid(workspaceId) ||
    !Types.ObjectId.isValid(invitedBy)
  ) {
    throw new AppError("Invalid workspace or user ID", 400);
  }

  const workspace = await Workspace.findOne({
    _id: workspaceId,
    status: "ACTIVE",
  }).select("_id name");

  if (!workspace) {
    throw new AppError("Workspace not found", 404);
  }

  const email = input.email.toLowerCase();

  const existingUser = await User.findOne({ email }).select("_id isActive");

  if (existingUser && !existingUser.isActive) {
    throw new AppError("This user account is inactive", 400);
  }

  if (existingUser) {
    const existingMembership = await Membership.findOne({
      workspaceId: workspace._id,
      userId: existingUser._id,
      status: "ACTIVE",
    }).select("_id");

    if (existingMembership) {
      throw new AppError("This user is already a workspace member", 409);
    }
  }

  const now = new Date();

  const pendingInvitation = await Invitation.findOne({
    workspaceId: workspace._id,
    email,
    status: "PENDING",
  });

  if (pendingInvitation && pendingInvitation.expiresAt > now) {
    throw new AppError(
      "A pending invitation already exists for this email",
      409,
    );
  }

  if (pendingInvitation) {
    pendingInvitation.status = "EXPIRED";
    await pendingInvitation.save();
  }

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashInvitationToken(rawToken);

  const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

  const invitation = await Invitation.create({
    workspaceId: workspace._id,
    email,
    role: input.role,
    tokenHash,
    status: "PENDING",
    invitedBy: new Types.ObjectId(invitedBy),
    expiresAt,
  });

  return {
    invitation: {
      id: invitation._id.toString(),
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
    },

    // Development/testing only. Do not expose this in production.
    ...(process.env.NODE_ENV !== "production" && {
      invitationToken: rawToken,
    }),
  };
}

export async function acceptInvitation(rawToken: string, userId: string) {
  if (!Types.ObjectId.isValid(userId)) {
    throw new AppError("Invalid user ID", 400);
  }

  const user = await User.findById(userId).select("_id email isActive");

  if (!user || !user.isActive) {
    throw new AppError("Active user account not found", 404);
  }

  const tokenHash = hashInvitationToken(rawToken);

  const session = await mongoose.startSession();

  try {
    let acceptedWorkspaceId: string | undefined;

    await session.withTransaction(async () => {
      const invitation = await Invitation.findOne({
        tokenHash,
        status: "PENDING",
        expiresAt: { $gt: new Date() },
      }).session(session);

      if (!invitation) {
        throw new AppError(
          "Invitation is invalid, expired, or already used",
          400,
        );
      }

      if (invitation.email !== user.email.toLowerCase()) {
        throw new AppError(
          "This invitation was sent to a different email address",
          403,
        );
      }

      const workspace = await Workspace.findOne({
        _id: invitation.workspaceId,
        status: "ACTIVE",
      })
        .select("_id")
        .session(session);

      if (!workspace) {
        throw new AppError("Workspace not found or inactive", 404);
      }

      const existingMembership = await Membership.findOne({
        workspaceId: invitation.workspaceId,
        userId: user._id,
      }).session(session);

      if (existingMembership) {
        if (existingMembership.status === "ACTIVE") {
          throw new AppError("You are already a member of this workspace", 409);
        }

        if (existingMembership.status === "INVITED") {
          existingMembership.role = invitation.role;
          existingMembership.status = "ACTIVE";
          existingMembership.joinedAt = new Date();

          await existingMembership.save({ session });
        } else {
          throw new AppError(
            "Your membership is suspended. Contact a workspace administrator.",
            403,
          );
        }
      } else {
        await Membership.create(
          [
            {
              workspaceId: invitation.workspaceId,
              userId: user._id,
              role: invitation.role,
              status: "ACTIVE",
              joinedAt: new Date(),
            },
          ],
          { session },
        );
      }

      invitation.status = "ACCEPTED";
      invitation.acceptedAt = new Date();

      await invitation.save({ session });

      acceptedWorkspaceId = invitation.workspaceId.toString();
    });

    if (!acceptedWorkspaceId) {
      throw new AppError("Unable to accept invitation", 500);
    }

    return {
      workspaceId: acceptedWorkspaceId,
      message: "Invitation accepted successfully",
    };
  } finally {
    await session.endSession();
  }
}
