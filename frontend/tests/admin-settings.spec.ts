import { expect, test } from "@playwright/test";

test("admin settings persist font and use the saved key only for assistant chat", async ({ page }) => {
  const key = "AQ.fake-gemini-settings-key";
  await page.addInitScript(() => sessionStorage.setItem("thien-an-token", "settings-test-code"));
  await page.route("**/api/overview?**", (route) => {
    expect(route.request().headers()["x-thien-an-gemini-key"]).toBeUndefined();
    return route.fulfill({
      json: { gross: 0, refunded: 0, net: 0, count: 0, daily: [], categories: {}, items: [], total: 0, page: 1, pages: 1 },
    });
  });
  const suppliedKeys: (string | undefined)[] = [];
  await page.route("**/api/assistant/chat", (route) => {
    suppliedKeys.push(route.request().headers()["x-thien-an-gemini-key"]);
    return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"text":"Đã nhận tin nhắn."}\n\n' });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Cài đặt" }).click();
  const settings = page.getByRole("dialog", { name: "Cài đặt" });
  await settings.getByLabel("Khóa API Gemini").fill(' \u200B"' + key + '"\u2060 ');
  await settings.getByLabel("Cỡ chữ trang Admin").selectOption("xlarge");
  await settings.getByRole("button", { name: "Lưu cài đặt" }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveCSS("font-size", "20px");
  await page.getByRole("link", { name: "Trợ lý AI" }).click();
  const input = page.getByRole("textbox", { name: "Tin nhắn" });
  await input.fill("Kiểm tra khóa đã lưu");
  await input.press("Enter");
  await expect(page.getByText("Đã nhận tin nhắn.")).toBeVisible();
  expect(suppliedKeys).toEqual([key]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Cài đặt" }).click();
  await expect(settings.getByLabel("Khóa API Gemini")).toHaveValue("");
  await expect(settings.getByLabel("Cỡ chữ trang Admin")).toHaveValue("xlarge");
  await settings.getByRole("button", { name: "Xóa khóa đã lưu" }).click();
  await settings.getByLabel("Cỡ chữ trang Admin").selectOption("normal");
  await settings.getByRole("button", { name: "Lưu cài đặt" }).click();
  await expect(page.locator("html")).toHaveCSS("font-size", "16px");
  await input.fill("Kiểm tra sau khi xóa");
  await input.press("Enter");
  await expect(page.getByText("Đã nhận tin nhắn.")).toHaveCount(2);
  expect(suppliedKeys).toEqual([key, undefined]);
});
