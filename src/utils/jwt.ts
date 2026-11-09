import jwt, { type JwtPayload, type SignOptions } from "jsonwebtoken";

const getJwtSecret = (): string => {
  const secret = process.env.JWT_ACCESS_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error(
      "JWT_ACCESS_SECRET must be configured with a sufficiently strong secret",
    );
  }

  return secret;
};

const getAccessTokenExpiry = (): NonNullable<SignOptions["expiresIn"]> => {
  const expiry = process.env.JWT_ACCESS_EXPIRES_IN || "7d";

  if (!/^\d+(s|m|h|d)$/.test(expiry)) {
    throw new Error("Invalid JWT_ACCESS_EXPIRES_IN configuration");
  }

  return expiry as NonNullable<SignOptions["expiresIn"]>;
};

export const generateAccessToken = (userId: string): string => {
  return jwt.sign({}, getJwtSecret(), {
    subject: userId,
    expiresIn: getAccessTokenExpiry(),
    algorithm: "HS256",
  });
};

export const verifyAccessToken = (token: string): JwtPayload => {
  const payload = jwt.verify(token, getJwtSecret(), {
    algorithms: ["HS256"],
  });

  if (
    typeof payload === "string" ||
    typeof payload.sub !== "string" ||
    !payload.sub
  ) {
    throw new Error("Invalid token payload");
  }

  return payload;
};

export const generateStepUpToken = (adminUserId: string): string => {
  return jwt.sign({ purpose: "ADMIN_STEP_UP" }, getJwtSecret(), {
    subject: adminUserId,
    expiresIn: "7d",
    algorithm: "HS256",
  });
};

export const verifyStepUpToken = (
  token: string,
  adminUserId: string,
): boolean => {
  try {
    const payload = jwt.verify(token, getJwtSecret(), {
      algorithms: ["HS256"],
    }) as JwtPayload;

    return (
      Boolean(payload) &&
      payload.purpose === "ADMIN_STEP_UP" &&
      payload.sub === adminUserId
    );
  } catch {
    return false;
  }
};
