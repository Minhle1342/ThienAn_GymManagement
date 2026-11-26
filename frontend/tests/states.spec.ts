import { test, expect } from "@playwright/test";
test("empty and recoverable error states", async ({ page }) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("thien-an-token", "test-token"),
  );
  await page.route("**/api/overview?**", (route) =>
    route.fulfill({ status: 500, body: "Không thể tải dữ liệu kiểm thử." }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText(
    "Không thể tải dữ liệu kiểm thử.",
  );
  await page.route("**/api/overview?**", (route) =>
    route.fulfill({
      json: {
        gross: 0,
        net: 0,
        refunded: 0,
        count: 0,
        daily: [],
        categories: {},
        items: [],
        total: 0,
        page: 1,
        pages: 1,
      },
    }),
  );
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByText("Chưa có giao dịch phù hợp")).toBeVisible();
  await expect(page.getByLabel("Trang trước")).toBeDisabled();
  await expect(page.getByLabel("Trang sau")).toBeDisabled();
});
test("incorrect access code stays on sign in", async ({ page }) => {
  await page.route("**/api/overview", (route) =>
    route.fulfill({ status: 401 }),
  );
  await page.goto("/");
  await page.getByLabel("Mã truy cập quản trị").fill("incorrect");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByRole("alert")).toContainText("Mã truy cập chưa đúng");
});
