import mongoose from "mongoose";

import Workspace from "./workspace.model.js";
import Membership from "./membership.model.js";
import { AuthError } from "../auth/auth.service.js";
import type { CreateWorkspaceInput } from "./workspace.validation.js";

const createSlugBase = (name: string): string => {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");

  return slug || "workspace";
};

export const createWorkspace = async (
  userId: string,
  input: CreateWorkspaceInput,
) => {
  const session = await mongoose.startSession();

  try {
    let result: {
      id: string;
      name: string;
      slug: string;
      ownerId: string;
      role: string;
      status: string;
    } | null = null;

    await session.withTransaction(async () => {
      let workspace:
        | Awaited<ReturnType<typeof Workspace.create>>[number]
        | undefined;

      for (let attempt = 0; attempt < 5; attempt++) {
        const suffix = Math.random().toString(36).slice(2, 8);
        const slug = `${createSlugBase(input.name)}-${suffix}`;

        try {
          const created = await Workspace.create(
            [
              {
                name: input.name,
                slug,
                ownerId: userId,
              },
            ],
            { session },
          );

          workspace = created[0];
          break;
        } catch (error: unknown) {
          const isDuplicate =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === 11000;

          if (!isDuplicate || attempt === 4) {
            throw error;
          }
        }
      }

      if (!workspace) {
        throw new Error("Unable to generate a unique workspace slug");
      }

      await Membership.create(
        [
          {
            workspaceId: workspace._id,
            userId,
            role: "OWNER",
            status: "ACTIVE",
          },
        ],
        { session },
      );

      result = {
        id: workspace._id.toString(),
        name: workspace.name,
        slug: workspace.slug,
        ownerId: workspace.ownerId.toString(),
        role: "OWNER",
        status: workspace.status,
      };
    });

    if (!result) {
      throw new Error("Workspace creation failed");
    }

    return result;
  } finally {
    await session.endSession();
  }
};

export const getUserWorkspaces = async (userId: string) => {
  const memberships = await Membership.find({
    userId,
    status: "ACTIVE",
  })
    .populate({
      path: "workspaceId",
      match: { status: "ACTIVE" },
      select: "name slug ownerId status timezone currency createdAt",
    })
    .lean();

  return memberships
    .filter((membership) => membership.workspaceId !== null)
    .map((membership) => {
      const workspace = membership.workspaceId as unknown as {
        _id: mongoose.Types.ObjectId;
        name: string;
        slug: string;
        ownerId: mongoose.Types.ObjectId;
        status: string;
        timezone: string;
        currency: string;
        createdAt: Date;
      };

      return {
        id: workspace._id.toString(),
        name: workspace.name,
        slug: workspace.slug,
        ownerId: workspace.ownerId.toString(),
        status: workspace.status,
        timezone: workspace.timezone,
        currency: workspace.currency,
        role: membership.role,
        joinedAt: membership.joinedAt,
      };
    });
};
