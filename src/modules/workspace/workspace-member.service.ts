import { Types } from "mongoose";

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
