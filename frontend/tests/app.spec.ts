import { test, expect } from "@playwright/test";
test("record a real payment, inspect it, refund it, and export", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Mã truy cập quản trị").fill("local-test-token-2026");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(
    page.getByRole("heading", { name: "Quản lý thu nhập" }),
  ).toBeVisible();
  await expect(page.locator(".stat").first()).toBeVisible();
  await page.screenshot({ path: "test-results/desktop.png", fullPage: true });
  await page.getByRole("button", { name: "Ghi nhận khoản thu" }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Hội viên", { exact: true })
    .fill("Hội viên kiểm thử " + Date.now());
  await dialog
    .getByLabel("Nội dung", { exact: true })
    .fill("Gói kiểm thử tích hợp");
  await dialog.getByLabel("Số tiền (VND)", { exact: true }).fill("1250000");
  await dialog.getByRole("button", { name: "Lưu khoản thu" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã ghi nhận khoản thu.");
  await page.getByLabel("Tìm giao dịch").fill("Gói kiểm thử tích hợp");
  await page
    .getByRole("button")
    .filter({ hasText: "Gói kiểm thử tích hợp" })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "Chi tiết giao dịch" }),
  ).toBeVisible();
  await page.getByLabel(/Số tiền hoàn/).fill("250000");
  await page.getByLabel("Lý do hoàn").fill("Kiểm thử hoàn một phần");
  await page.getByRole("button", { name: "Xác nhận hoàn tiền" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã ghi nhận hoàn tiền.");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Xuất dữ liệu" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe(
    "thien-an-thu-nhap.csv",
  );
});
test("mobile layout fits 390px and dialog supports keyboard dismissal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    sessionStorage.setItem("thien-an-token", "local-test-token-2026"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Quản lý thu nhập" }),
  ).toBeVisible();
  await expect(page.locator(".stat").first()).toBeVisible();
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Ghi nhận khoản thu" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialog = page.getByRole("dialog");
  const description = "Khoản thu theo ngày " + Date.now();
  await dialog.getByLabel("Hội viên", { exact: true }).fill("Hội viên kiểm thử");
  await dialog.getByLabel("Nội dung", { exact: true }).fill(description);
  await dialog.getByRole("combobox", { name: "Nguồn thu", exact: true }).selectOption("daily");
  await dialog.getByLabel("Số tiền (VND)", { exact: true }).fill("50000");
  await dialog.getByRole("button", { name: "Lưu khoản thu" }).click();
  const transaction = page.locator(".mobile-payment").filter({ hasText: description });
  await expect(transaction.getByText("Theo ngày", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Ghi nhận khoản thu" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
