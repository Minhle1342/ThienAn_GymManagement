import { test, expect } from "@playwright/test";
test("a slower transaction detail cannot replace the most recently selected transaction", async ({ page }) => {
  const older = {
    id: "TA-older", member: "Hội viên thử", description: "Giao dịch mở trước",
    category: "membership", method: "cash", status: "paid",
    amount: 100000, occurred_at: "2026-01-01T00:00:00Z", membership_months: null,
  };
  const latest = { ...older, id: "TA-latest", description: "Giao dịch mở sau", membership_months: 3 };
  await page.addInitScript(() => sessionStorage.setItem("thien-an-token", "test-detail"));
  await page.route("**/api/overview?**", (route) => route.fulfill({
    json: {
      gross: 200000, refunded: 0, net: 200000, count: 2, daily: [], categories: {},
      items: [older, latest], total: 2, page: 1, pages: 1,
    },
  }));
  let releaseOld!: () => void;
  const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route("**/api/transactions/TA-older", async (route) => {
    await oldResponse;
    await route.fulfill({ json: { payment: older, refunds: [] } });
  });
  await page.route("**/api/transactions/TA-latest", (route) =>
    route.fulfill({ json: { payment: latest, refunds: [] } }),
  );

  await page.goto("/");
  const firstRequest = page.waitForRequest("**/api/transactions/TA-older");
  await page.getByRole("button", { name: /TA-older/ }).click();
  await firstRequest;
  await page.getByRole("button", { name: /TA-latest/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("3 tháng", { exact: true })).toBeVisible();

  const lateResponse = page.waitForResponse("**/api/transactions/TA-older");
  releaseOld();
  await (await lateResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  ));
  await expect(dialog.getByText("TA-latest", { exact: true })).toBeVisible();
  await expect(dialog.getByText("3 tháng", { exact: true })).toBeVisible();
});

test("expired members toggle filters the transaction list across date ranges", async ({ page }) => {
  const member = "Hội viên hết hạn kiểm thử " + Date.now();
  const creation = await page.request.post("/api/transactions", {
    headers: { Authorization: "Bearer local-test-token-2026" },
    data: {
      member,
      category: "membership",
      membership_months: 1,
      description: "Gói hội viên 1 tháng",
      amount: 100000,
      method: "cash",
      status: "paid",
      occurred_at: "2024-01-30T18:00:00Z",
      idempotency_key: "expiry-e2e-" + Date.now(),
    },
  });
  expect(creation.ok()).toBeTruthy();
  await page.addInitScript(() =>
    sessionStorage.setItem("thien-an-token", "local-test-token-2026"),
  );
  await page.goto("/");
  await expect(page.locator(".transactions")).toBeVisible();
  const toggle = page.getByRole("button", { name: "Hội viên hết hạn", exact: true });
  await expect(page.getByText(member, { exact: true })).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("columnheader", { name: "Ngày hết hạn" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: member })).toContainText("29/02/2024");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("columnheader", { name: "Ngày hết hạn" })).toHaveCount(0);
  await expect(page.getByText(member, { exact: true })).toHaveCount(0);
});

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
  const source = dialog.getByRole("combobox", { name: "Nguồn thu", exact: true });
  const months = dialog.getByRole("spinbutton", { name: "Tổng tháng" });
  await dialog.getByRole("combobox", { name: "Chọn nhanh số tháng" }).selectOption("6");
  await expect(months).toHaveValue("6");
  await months.fill("4");
  await source.selectOption("daily");
  await expect(months).toHaveCount(0);
  await source.selectOption("membership");
  await expect(months).toHaveValue("4");
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
  await expect(page.getByRole("dialog").getByText("4 tháng", { exact: true })).toBeVisible();
  await page.getByLabel(/Số tiền hoàn/).fill("250000");
  await page.getByLabel("Lý do hoàn").fill("Kiểm thử hoàn một phần");
  await page.getByRole("button", { name: "Xác nhận hoàn tiền" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã ghi nhận hoàn tiền.");
  const refundText = /Đã hoàn 250\.000/;
  await expect(page.getByRole("row").filter({ hasText: "Gói kiểm thử tích hợp" }).getByText(refundText)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator(".mobile-payment").filter({ hasText: "Gói kiểm thử tích hợp" }).getByText(refundText)).toBeVisible();
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
