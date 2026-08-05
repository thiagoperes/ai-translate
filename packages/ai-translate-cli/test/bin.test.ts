import { afterEach, describe, expect, it, vi } from "vitest";

const mockRunCli = vi.hoisted(() => vi.fn());

vi.mock("../src/index", () => ({
  runCli: mockRunCli,
}));

describe("bin entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mockRunCli.mockReset();
  });

  it("exits using the CLI return code", async () => {
    mockRunCli.mockResolvedValue(7);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: string | number | null): never => {
        throw new Error(`process.exit:${String(code)}`);
      });

    await expect(
      import(new URL(`../src/bin.ts?case=${String(Date.now())}`, import.meta.url).href),
    ).rejects.toThrow("process.exit:7");

    expect(mockRunCli).toHaveBeenCalledWith();
    expect(exitSpy).toHaveBeenCalledWith(7);
  });
});
