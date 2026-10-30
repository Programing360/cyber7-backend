import mongoose, { Types } from "mongoose";

import { AppError } from "../../utils/app-error.js";
import Membership from "./membership.model.js";

interface ListWorkspaceMembersInput {
  workspaceId: string;
  page: number;
  limit: number;
}

export async function listWorkspaceMembers({
  workspaceId,
  page,
  limit,
}: ListWorkspaceMembersInput) {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new AppError("Invalid workspace ID", 400);
  }

  const skip = (page - 1) * limit;

  const filter = {
    workspaceId: new Types.ObjectId(workspaceId),
    status: "ACTIVE" as const,
  };

  const [members, total] = await Promise.all([
    Membership.find(filter)
      .populate({
        path: "userId",
        select: "name email role isActive",
        match: { isActive: true },
      })
      .select("userId role status joinedAt createdAt")
      .sort({ createdAt: 1 })
      .skip(skip)
      .limit(limit)
      .lean(),

    Membership.countDocuments(filter),
  ]);

  const safeMembers = members
    .filter((member) => member.userId !== null)
    .map((member) => {
      const user = member.userId as unknown as {
        _id: Types.ObjectId;
        name: string;
        email: string;
        role: string;
      };

      return {
        membershipId: member._id.toString(),
        user: {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
        },
        role: member.role,
        status: member.status,
        joinedAt: member.joinedAt,
      };
    });

  return {
    members: safeMembers,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };
}


interface UpdateMemberRoleParams {
  workspaceId: string;
  memberId: string;
  role: "ADMIN" | "AGENT";
  requesterId: string;
}

export async function updateWorkspaceMemberRole({
  workspaceId,
  memberId,
  role,
  requesterId,
}: UpdateMemberRoleParams) {
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(memberId) ||
    !mongoose.Types.ObjectId.isValid(requesterId)
  ) {
    throw new Error("Invalid ID provided");
  }

  // Verify the requester is an active OWNER of this workspace.
  const requesterMembership = await Membership.findOne({
    workspaceId,
    userId: requesterId,
    role: "OWNER",
    status: "ACTIVE",
  });

  if (!requesterMembership) {
    throw new Error("Only the workspace OWNER can update member roles");
  }

  // Prevent changing your own role.
  if (requesterId === memberId) {
    throw new Error("You cannot change your own role");
  }

  // Find the target member inside the same workspace.
  const targetMembership = await Membership.findOne({
    workspaceId,
    userId: memberId,
    status: "ACTIVE",
  });

  if (!targetMembership) {
    throw new Error("Active workspace member not found");
  }

  // Do not allow this endpoint to modify an OWNER.
  if (targetMembership.role === "OWNER") {
    throw new Error("OWNER role cannot be changed through this endpoint");
  }

  targetMembership.role = role;
  await targetMembership.save();

  return {
    memberId: targetMembership.userId.toString(),
    workspaceId: targetMembership.workspaceId.toString(),
    role: targetMembership.role,
  };
}



interface UpdateMemberStatusParams {
  workspaceId: string;
  memberId: string;
  status: "ACTIVE" | "SUSPENDED";
  requesterId: string;
}

export async function updateWorkspaceMemberStatus({
  workspaceId,
  memberId,
  status,
  requesterId,
}: UpdateMemberStatusParams) {
  // 1. Validate IDs
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(memberId) ||
    !mongoose.Types.ObjectId.isValid(requesterId)
  ) {
    throw new AppError("Invalid ID provided", 400);
  }

  // 2. Check requester membership
  const requesterMembership = await Membership.findOne({
    workspaceId,
    userId: requesterId,
    status: "ACTIVE",
  });

  if (!requesterMembership) {
    throw new AppError("Workspace membership not found", 403);
  }

  // 3. Only OWNER and ADMIN can update member status
  if (!["OWNER", "ADMIN"].includes(requesterMembership.role)) {
    throw new AppError(
      "You do not have permission to update member status",
      403,
    );
  }

  // 4. Prevent self-suspension
  if (requesterId === memberId && status === "SUSPENDED") {
    throw new AppError("You cannot suspend yourself", 403);
  }

  // 5. Find target member
  const targetMembership = await Membership.findOne({
    workspaceId,
    userId: memberId,
  });

  if (!targetMembership) {
    throw new AppError("Workspace member not found", 404);
  }

  // 6. Protect OWNER account
  if (targetMembership.role === "OWNER") {
    throw new AppError("OWNER status cannot be changed", 403);
  }

  // 7. Prevent unnecessary status updates
  if (targetMembership.status === status) {
    throw new AppError(
      `Member is already ${status}`,
      400,
    );
  }

  // 8. Update member status
  targetMembership.status = status;

  if (status === "ACTIVE") {
    targetMembership.joinedAt = new Date();
  }

  await targetMembership.save();

  return {
    memberId: targetMembership.userId.toString(),
    workspaceId: targetMembership.workspaceId.toString(),
    role: targetMembership.role,
    status: targetMembership.status,
  };
}


interface RemoveWorkspaceMemberParams {
  workspaceId: string;
  memberId: string;
  requesterId: string;
}

export async function removeWorkspaceMember({
  workspaceId,
  memberId,
  requesterId,
}: RemoveWorkspaceMemberParams) {
  // 1. Validate IDs
  if (
    !mongoose.Types.ObjectId.isValid(workspaceId) ||
    !mongoose.Types.ObjectId.isValid(memberId) ||
    !mongoose.Types.ObjectId.isValid(requesterId)
  ) {
    throw new AppError("Invalid ID provided", 400);
  }

  // 2. Find requester membership
  const requesterMembership = await Membership.findOne({
    workspaceId,
    userId: requesterId,
    status: "ACTIVE",
  });

  if (!requesterMembership) {
    throw new AppError("Workspace membership not found", 403);
  }

  // 3. Only OWNER and ADMIN can remove members
  if (!["OWNER", "ADMIN"].includes(requesterMembership.role)) {
    throw new AppError(
      "You do not have permission to remove members",
      403,
    );
  }

  // 4. Prevent self-removal
  if (requesterId === memberId) {
    throw new AppError("You cannot remove yourself", 403);
  }

  // 5. Find target membership
  const targetMembership = await Membership.findOne({
    workspaceId,
    userId: memberId,
  });

  if (!targetMembership) {
    throw new AppError("Workspace member not found", 404);
  }

  // 6. Protect OWNER
  if (targetMembership.role === "OWNER") {
    throw new AppError("Workspace OWNER cannot be removed", 403);
  }

  // 7. ADMIN can remove AGENT only
  if (
    requesterMembership.role === "ADMIN" &&
    targetMembership.role !== "AGENT"
  ) {
    throw new AppError(
      "ADMIN can only remove AGENT members",
      403,
    );
  }

  // 8. Remove membership
  await Membership.deleteOne({
    _id: targetMembership._id,
    workspaceId,
  });

  return {
    memberId: targetMembership.userId.toString(),
    workspaceId: targetMembership.workspaceId.toString(),
    removed: true,
  };
}