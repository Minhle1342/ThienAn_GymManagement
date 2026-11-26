import { expect, test } from "@playwright/test";

test("Vietnam schedule preserves a past date and time across midnight", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-11-25T16:58:30Z") });
  await page.addInitScript(() => sessionStorage.setItem("thien-an-token", "schedule-test-code"));
  await page.route("**/api/overview?**", (route) => route.fulfill({
    json: { gross: 0, refunded: 0, net: 0, count: 0, daily: [], categories: {}, items: [], total: 0, page: 1, pages: 1 },
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Ghi nhận khoản thu" }).click();
  const schedule = page.getByRole("group", { name: "Thời điểm (giờ Việt Nam)" });
  const day = schedule.getByLabel("Ngày", { exact: true });
  const hour = schedule.getByLabel("Giờ", { exact: true });
  const minute = schedule.getByLabel("Phút", { exact: true });
  await expect(day).toHaveValue("2026-11-25");
  await expect(hour).toHaveValue("23");
  await expect(minute).toHaveValue("58");
  await expect(hour.locator("option")).toHaveCount(24);
  await expect(minute.locator("option")).toHaveCount(60);

  await hour.selectOption("08");
  await minute.selectOption("05");
  await day.fill("2026-11-24");
  await page.clock.fastForward(90_000);
  await expect(day).toHaveValue("2026-11-24");
  await expect(hour).toHaveValue("08");
  await expect(minute).toHaveValue("05");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Hội viên", { exact: true }).fill("Khách kiểm thử");
  await dialog.getByLabel("Nội dung", { exact: true }).fill("Gói tập");
  await dialog.getByLabel("Số tiền (VND)", { exact: true }).fill("100000");
  await page.route("**/api/transactions", (route) => {
    expect(route.request().postDataJSON().occurred_at).toBe("2026-11-24T01:05:00.000Z");
    return route.fulfill({ json: { id: "TA-test" } });
  });
  await dialog.getByRole("button", { name: "Lưu khoản thu" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã ghi nhận khoản thu.");
});
