import { afterEach, describe, expect, it, vi } from "vitest";

const mockRunCli = vi.hoisted(() => vi.fn<() => Promise<number>>());

vi.mock("@ai-translate/cli", () => ({ runCli: mockRunCli }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  mockRunCli.mockReset();
});

describe("unscoped launcher", () => {
  it("exports the shared runner without starting a command on import", async () => {
    const { runCli } = await import("../src/index");
    expect(runCli).toBe(mockRunCli);
    expect(mockRunCli).not.toHaveBeenCalled();
  });

  it.each([0, 7])("preserves the shared runner's exit code %i", async (code) => {
    mockRunCli.mockResolvedValue(code);
    const exit = vi.spyOn(process, "exit").mockImplementation((value): never => {
      throw new Error(`process.exit:${String(value)}`);
    });

    await expect(import("../src/bin")).rejects.toThrow(`process.exit:${String(code)}`);

    expect(mockRunCli).toHaveBeenCalledExactlyOnceWith();
    expect(exit).toHaveBeenCalledExactlyOnceWith(code);
  });
});
