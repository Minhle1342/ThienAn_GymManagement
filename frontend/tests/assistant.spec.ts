import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem("thien-an-token", "assistant-test-code"));
  await page.route("**/api/overview?**", (route) => route.fulfill({
    json: { gross: 0, refunded: 0, net: 0, count: 0, daily: [], categories: {}, items: [], total: 0, page: 1, pages: 1 },
  }));
});

test("desktop navigation preserves filters and chat while showing scoped evidence", async ({ page }) => {
  await page.route("**/api/assistant/chat", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer assistant-test-code");
    expect(route.request().postDataJSON()).toEqual({ message: "Tổng thu tháng này?", history: [] });
    await route.fulfill({
      contentType: "text/event-stream",
      body: [
        "event: status\ndata: " + JSON.stringify({ message: "Đang tra cứu dữ liệu…" }),
        "event: tool_start\ndata: " + JSON.stringify({ index: 0, name: "summarize_income" }),
        "event: tool_result\ndata: " + JSON.stringify({ index: 0, name: "summarize_income", result: { gross: 500 } }),
        "event: done\ndata: " + JSON.stringify({
          text: "Đã thu **500 VND**. <script>Không được thực thi</script>\n\n| Nguồn | Thu |\n| --- | --- |\n| Tiền mặt | 500 |",
          evidence: [{ tool: "summarize_income", filters: { from: "2026-11-01", method: "cash" }, partial: false }],
        }),
      ].join("\n\n") + "\n\n",
    });
  });
  await page.goto("/");
  await page.getByLabel("Phương thức", { exact: true }).selectOption("cash");
  await page.getByRole("link", { name: "Trợ lý AI" }).click();
  await expect(page).toHaveURL(/\/tro-ly-ai$/);
  await expect(page.getByRole("link", { name: "Trợ lý AI" })).toHaveAttribute("aria-current", "page");
  const input = page.getByRole("textbox", { name: "Tin nhắn" });
  await input.fill("Tổng thu tháng này?");
  await input.press("Enter");
  await expect(page.getByText(/Đã thu 500 VND/)).toContainText("<script>");
  await expect(page.locator(".assistant-text strong")).toHaveText("500 VND");
  await expect(page.locator(".assistant-text script")).toHaveCount(0);
  await expect(page.getByRole("columnheader", { name: "Nguồn" })).toBeVisible();
  await page.locator(".assistant-tools summary").click();
  await expect(page.locator(".assistant-tools pre")).toContainText('"gross": 500');
  await page.getByText("Dữ liệu đã tra cứu").click();
  await expect(page.getByText(/Phương thức Tiền mặt/)).toBeVisible();
  await page.goBack();
  await expect(page.getByLabel("Phương thức", { exact: true })).toHaveValue("cash");
  await page.goForward();
  await expect(page.getByText(/Đã thu 500 VND/)).toBeVisible();
  await page.getByRole("button", { name: "Cuộc trò chuyện mới" }).click();
  await expect(page.getByText(/Đã thu 500 VND/)).toHaveCount(0);
});

test("mobile direct route reports missing Gemini configuration and retries the same message", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let requests = 0;
  await page.route("**/api/assistant/chat", (route) => {
    requests++;
    expect(route.request().postDataJSON().history).toEqual([]);
    return route.fulfill({ status: 503, body: "Trợ lý AI chưa được cấu hình." });
  });
  await page.goto("/tro-ly-ai");
  await page.reload();
  await expect(page.getByRole("region", { name: "Trợ lý AI", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole("button", { name: "Tháng này đã thu bao nhiêu?" }).click();
  await page.getByRole("button", { name: "Gửi tin nhắn" }).click();
  await expect(page.getByRole("alert")).toContainText("chưa được cấu hình");
  await page.getByRole("button", { name: "Thử lại" }).click();
  await expect(page.getByRole("alert")).toContainText("chưa được cấu hình");
  expect(requests).toBe(2);
  await expect(page.locator(".assistant-message-user")).toHaveCount(1);
  await page.getByRole("navigation", { name: "Điều hướng di động" }).getByRole("link", { name: "Thu nhập" }).click();
  await expect(page.getByRole("heading", { name: "Quản lý thu nhập" })).toBeVisible();
});

test("a stopped request does not append an assistant reply", async ({ page }) => {
  let releaseResponse!: () => void;
  const pending = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/api/assistant/chat", async (route) => {
    await pending;
    await route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"text":"Phản hồi muộn"}\n\n' }).catch(() => {});
  });
  await page.goto("/tro-ly-ai");
  await page.getByRole("textbox", { name: "Tin nhắn" }).fill("Tra cứu tổng thu");
  await page.getByRole("button", { name: "Gửi tin nhắn" }).click();
  await page.getByRole("button", { name: "Dừng trả lời" }).click();
  releaseResponse();
  await expect(page.getByRole("button", { name: "Gửi tin nhắn" })).toBeVisible();
  await expect(page.getByText("Phản hồi muộn")).toHaveCount(0);
});
