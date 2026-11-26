import { test, expect } from "@playwright/test";

test("all money fields group thousands and submit integer VND", async ({
  page,
}) => {
  const payment = {
    id: "TA-format-test",
    member: "Hội viên thử định dạng",
    description: "Gói tập",
    category: "membership",
    method: "cash",
    amount: 1250000,
    status: "paid",
    occurred_at: "2026-11-25T02:00:00Z",
  };
  await page.addInitScript(() =>
    sessionStorage.setItem("thien-an-token", "format-test"),
  );
  await page.route("**/api/overview?**", (route) =>
    route.fulfill({
      json: {
        gross: 1250000,
        net: 1250000,
        refunded: 0,
        count: 1,
        daily: [],
        categories: { membership: 1250000 },
        items: [payment],
        total: 1,
        page: 1,
        pages: 1,
      },
    }),
  );
  await page.route("**/api/transactions/TA-format-test", (route) =>
    route.fulfill({ json: { payment, refunds: [] } }),
  );
  await page.route("**/api/transactions", async (route) => {
    expect(route.request().postDataJSON().amount).toBe(1250000);
    await route.fulfill({ json: { id: payment.id } });
  });
  await page.route(
    "**/api/transactions/TA-format-test/refunds",
    async (route) => {
      expect(route.request().postDataJSON().amount).toBe(250000);
      await route.fulfill({ json: { id: "refund-test" } });
    },
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Ghi nhận khoản thu" }).click();
  const amount = page.getByLabel("Số tiền (VND)", { exact: true });
  await amount.pressSequentially("1250000");
  await expect(amount).toHaveValue("1.250.000");
  await amount.fill("100000000001");
  expect(
    await amount.evaluate((input: HTMLInputElement) => input.validity.valid),
  ).toBeFalsy();
  await amount.fill("0");
  expect(
    await amount.evaluate((input: HTMLInputElement) => input.validity.valid),
  ).toBeFalsy();
  await amount.fill("1.250.000");
  await amount.evaluate((input: HTMLInputElement) =>
    input.setSelectionRange(2, 2),
  );
  await amount.press("Backspace");
  await expect(amount).toHaveValue("250.000");
  await amount.fill("1.250.000");
  await page
    .getByRole("dialog")
    .getByLabel("Hội viên", { exact: true })
    .fill("Hội viên thử định dạng");
  await page
    .getByRole("dialog")
    .getByLabel("Nội dung", { exact: true })
    .fill("Gói tập");
  await page.getByRole("button", { name: "Lưu khoản thu" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã ghi nhận khoản thu.");
  await page
    .getByRole("button")
    .filter({ hasText: "Hội viên thử định dạng" })
    .first()
    .click();
  const refund = page.getByLabel(/Số tiền hoàn/);
  await refund.fill("1.250.001");
  expect(
    await refund.evaluate((input: HTMLInputElement) => input.validity.valid),
  ).toBeFalsy();
  await refund.fill("250000");
  await expect(refund).toHaveValue("250.000");
  await page.getByLabel("Lý do hoàn").fill("Đổi gói");
  await page.getByRole("button", { name: "Xác nhận hoàn tiền" }).click();
  await expect(page.getByRole("status")).toHaveText("Đã ghi nhận hoàn tiền.");
});
