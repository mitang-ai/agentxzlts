import { ApiError } from "./client";

export type QuickAccount = {
  email: string;
  password: string;
  display_name: string;
};

export function createQuickAccount(): QuickAccount {
  const hex = (length: number) =>
    Array.from(crypto.getRandomValues(new Uint8Array(length)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const id = hex(16);
  return {
    email: `member-${id}@accounts.invalid`,
    password: hex(24),
    display_name: `岛友 ${id.slice(0, 6)}`,
  };
}

// Keep the same credentials in memory after an uncertain response. A retry
// must never create another identity, or sign in without its exact password.
export async function registerQuickAccount<T>(
  account: QuickAccount,
  request: (path: string, body: QuickAccount) => Promise<T>,
): Promise<T> {
  try {
    return await request("auth/register", account);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) throw error;
    return request("auth/login", account);
  }
}
