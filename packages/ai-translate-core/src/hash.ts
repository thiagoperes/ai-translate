import { createHash } from "node:crypto";

export function digestValue(value: boolean | number | string | null): string {
  return createHash("sha256").update(String(value)).digest("hex");
}
