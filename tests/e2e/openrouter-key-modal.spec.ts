import { expect, test, type Page } from "@playwright/test";

type ProviderStatus = {
  hasKey: boolean;
  hasPersonalKey: boolean;
  keyPrefix: string | null;
  source: "personal" | "shared" | null;
};

type ImpersonationState = {
  canImpersonate: boolean;
  activeSession: null | {
    _id: string;
    targetUserId: string;
    startedAt: number;
  };
};

const noKeyStatus: ProviderStatus = {
  hasKey: false,
  hasPersonalKey: false,
  keyPrefix: null,
  source: null,
};

const sharedKeyStatus: ProviderStatus = {
  hasKey: true,
  hasPersonalKey: false,
  keyPrefix: "sk-or-v1-share",
  source: "shared",
};

const personalKeyStatus: ProviderStatus = {
  hasKey: true,
  hasPersonalKey: true,
  keyPrefix: "sk-or-v1-user",
  source: "personal",
};

async function setE2EDashboardState(
  page: Page,
  providerStatus: ProviderStatus,
  impersonationState: ImpersonationState = { canImpersonate: false, activeSession: null },
) {
  await page.addInitScript(({ status, impersonation }) => {
    window.localStorage.setItem("memory-crystal:e2e-openrouter-status", JSON.stringify(status));
    window.localStorage.setItem("memory-crystal:e2e-impersonation-state", JSON.stringify(impersonation));
  }, { status: providerStatus, impersonation: impersonationState });
}

test.describe("OpenRouter key modal", () => {
  test("no-key users see an accessible modal that links to Settings and dismisses for the session", async ({ page }) => {
    await setE2EDashboardState(page, noKeyStatus);
    await page.goto("/dashboard");

    const dialog = page.getByRole("dialog", { name: "Add your OpenRouter key" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("semantic recall embeddings");
    await expect(dialog).toContainText("OpenRouter bills usage to your OpenRouter account");

    const primary = page.getByRole("link", { name: /add key in settings/i });
    await expect(primary).toHaveAttribute("href", "/settings#provider-keys");
    await expect(primary).toBeFocused();

    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /not now/i })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: /dismiss openrouter key reminder/i })).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(dialog).toBeHidden();
  });

  test("shared-key fallback users still get prompted", async ({ page }) => {
    await setE2EDashboardState(page, sharedKeyStatus);
    await page.goto("/dashboard");

    await expect(page.getByRole("dialog", { name: "Add your OpenRouter key" })).toBeVisible();
  });

  test("personal-key users are not prompted", async ({ page }) => {
    await setE2EDashboardState(page, personalKeyStatus);
    await page.goto("/dashboard");

    await expect(page.getByRole("dialog", { name: "Add your OpenRouter key" })).toHaveCount(0);
  });

  test("Settings route suppresses the modal and exposes the provider key anchor", async ({ page }) => {
    await setE2EDashboardState(page, noKeyStatus);
    await page.goto("/settings#provider-keys");

    await expect(page.getByRole("dialog", { name: "Add your OpenRouter key" })).toHaveCount(0);
    await expect(page.locator("#provider-keys")).toBeVisible();
    await expect(page.getByText("OpenRouter bills usage to your OpenRouter account")).toBeVisible();
  });

  test("support impersonation suppresses the modal", async ({ page }) => {
    await setE2EDashboardState(page, noKeyStatus, {
      canImpersonate: true,
      activeSession: {
        _id: "session-e2e",
        targetUserId: "target-user",
        startedAt: Date.now(),
      },
    });
    await page.goto("/dashboard");

    await expect(page.getByText(/SUPPORT MODE:/)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Add your OpenRouter key" })).toHaveCount(0);
  });

  test("modal fits mobile viewport without overflowing the screen", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await setE2EDashboardState(page, noKeyStatus);
    await page.goto("/dashboard");

    const dialog = page.getByRole("dialog", { name: "Add your OpenRouter key" });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  });
});
