import { Types } from "mongoose";
import { AppError } from "../../../utils/app-error.js";
import { Invitation } from "../invitation/invitation.model.js";


interface ListInvitationsInput {
  workspaceId: string;
  page: number;
  limit: number;
}

export async function listWorkspaceInvitations({
  workspaceId,
  page,
  limit,
}: ListInvitationsInput) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("Invalid workspace ID", 400);
  }

  // Mark expired pending invitations
  await Invitation.updateMany(
    {
      workspaceId,
      status: "PENDING",
      expiresAt: { $lte: new Date() },
    },
    {
      $set: { status: "EXPIRED" },
    },
  );

  const filter = {
    workspaceId,
    status: "PENDING" as const,
    expiresAt: { $gt: new Date() },
  };

  const skip = (page - 1) * limit;

  const [invitations, total] = await Promise.all([
    Invitation.find(filter)
      .populate({
        path: "invitedBy",
        select: "name email",
      })
      .select("-tokenHash")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Invitation.countDocuments(filter),
  ]);

  return {
    invitations: invitations.map((invitation) => {
      const inviter = invitation.invitedBy as unknown as {
        _id: Types.ObjectId;
        name: string;
        email: string;
      } | null;

      return {
        id: invitation._id.toString(),
        email: invitation.email,
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
        invitedBy: inviter
          ? {
              id: inviter._id.toString(),
              name: inviter.name,
              email: inviter.email,
            }
          : null,
      };
    }),

    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}

export async function revokeWorkspaceInvitation(
  workspaceId: string,
  invitationId: string,
) {
  if (
    !Types.ObjectId.isValid(workspaceId) ||
    !Types.ObjectId.isValid(invitationId)
  ) {
    throw new AppError("Invalid workspace or invitation ID", 400);
  }

  const invitation = await Invitation.findOneAndUpdate(
    {
      _id: invitationId,
      workspaceId,
      status: "PENDING",
      expiresAt: { $gt: new Date() },
    },
    {
      $set: { status: "REVOKED" },
    },
    {
      new: true,
    },
  ).select("-tokenHash");

  if (!invitation) {
    throw new AppError("Pending invitation not found or already expired", 404);
  }

  return {
    id: invitation._id.toString(),
    email: invitation.email,
    role: invitation.role,
    status: invitation.status,
  };
}
