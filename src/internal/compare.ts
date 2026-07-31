import { timingSafeEqual } from "crypto";

/**
 * Compares two payload hashes without leaking how many leading characters
 * matched through the comparison's running time.
 */
export const constantTimeEquals = (left: string, right: string): boolean => {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
};
