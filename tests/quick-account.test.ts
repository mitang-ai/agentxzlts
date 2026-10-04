import { expect, it, vi } from "vitest";
import {
  createQuickAccount,
  registerQuickAccount,
} from "../apps/web/src/lib/quick-account";
import { ApiError } from "../apps/web/src/lib/client";

it("uses independent cryptographic identifiers and 192-bit passwords", () => {
  const a = createQuickAccount(),
    b = createQuickAccount();
  expect(a.email).toMatch(/^member-[a-f0-9]{32}@accounts\.invalid$/);
  expect(a.password).toMatch(/^[a-f0-9]{48}$/);
  expect(a.email).not.toBe(b.email);
  expect(a.password).not.toBe(b.password);
  expect(a.display_name).toMatch(/^岛友 [a-f0-9]{6}$/);
});

it("registers once without an additional login on success", async () => {
  const account = createQuickAccount();
  const request = vi.fn().mockResolvedValue({ user: { id: "fixture" } });
  expect(await registerQuickAccount(account, request)).toEqual({
    user: { id: "fixture" },
  });
  expect(request.mock.calls).toEqual([["auth/register", account]]);
});

it("recovers an uncertain successful registration only with the original password", async () => {
  const account = createQuickAccount();
  const request = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(409, "already registered"))
    .mockResolvedValueOnce({ recovered: true });
  expect(await registerQuickAccount(account, request)).toEqual({
    recovered: true,
  });
  expect(request.mock.calls).toEqual([
    ["auth/register", account],
    ["auth/login", account],
  ]);
});

it.each([403, 429, 500])(
  "does not bypass policy or errors (%s)",
  async (status) => {
    const error = new ApiError(status, "denied"),
      request = vi.fn().mockRejectedValue(error);
    await expect(
      registerQuickAccount(createQuickAccount(), request),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  },
);

it("never disguises a credential mismatch as a successful recovery", async () => {
  const error = new ApiError(401, "invalid password");
  const request = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(409, "exists"))
    .mockRejectedValueOnce(error);
  await expect(
    registerQuickAccount(createQuickAccount(), request),
  ).rejects.toBe(error);
});
