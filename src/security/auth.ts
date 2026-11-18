import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export const digest = (s: string) => createHash("sha256").update(s).digest();
export function authenticator(clients: Record<string, string>) {
  const credentials = Object.entries(clients).map(([owner, token]) => ({
    owner,
    key: digest("Bearer " + token),
  }));
  return (request: FastifyRequest) => {
    const provided = digest(request.headers.authorization ?? "");
    for (const entry of credentials)
      if (timingSafeEqual(entry.key, provided)) return entry.owner;
    throw new ApiError(401, "unauthorized");
  };
}
