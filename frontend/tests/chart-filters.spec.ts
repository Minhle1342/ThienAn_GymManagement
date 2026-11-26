import { test, expect } from "@playwright/test";

test("duplicate source rows become one chronologically sorted income column per day", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() =>
    sessionStorage.setItem("thien-an-token", "chart-filter-test"),
  );
  await page.route("**/api/overview?**", (route) => {
    const filters = new URL(route.request().url()).searchParams;
    const rows = [
      {
        date: "2026-11-26",
        income: 400000,
        refund: 0,
        category: "class",
        method: "transfer",
      },
      {
        date: "2026-11-25",
        income: 100000,
        refund: 5000,
        category: "membership",
        method: "cash",
      },
      {
        date: "2026-11-25",
        income: 200000,
        refund: 10000,
        category: "membership",
        method: "cash",
      },
      {
        date: "2026-11-25",
        income: 300000,
        refund: 0,
        category: "pt",
        method: "cash",
      },
    ].filter(
      (row) =>
        (!filters.get("category") ||
          filters.get("category") === row.category) &&
        (!filters.get("method") || filters.get("method") === row.method),
    );
    return route.fulfill({
      json: {
        gross: rows.reduce((n, r) => n + r.income, 0),
        refunded: 15000,
        net: 0,
        count: rows.length,
        daily: rows,
        categories: {},
        items: [],
        total: 0,
        page: 1,
        pages: 1,
      },
    });
  });
  await page.goto("/");
  const bars = page.locator(".bar:not(.refund-bar)");
  await expect(bars).toHaveCount(2);
  await expect(bars.nth(0)).toHaveAttribute(
    "aria-label",
    /2026-11-25: thu 600\.000/,
  );
  await expect(bars.nth(1)).toHaveAttribute(
    "aria-label",
    /2026-11-26: thu 400\.000/,
  );
  await expect(page.locator(".refund-bar")).toHaveCount(1);
  await bars.nth(0).focus();
  const tooltip = page.locator(".tooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText(/Hoàn 15\.000/);
  const tooltipFits = await tooltip.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const plot = element.parentElement!.getBoundingClientRect();
    return box.left >= plot.left && box.right <= plot.right && box.top >= plot.top;
  });
  expect(tooltipFits).toBe(true);
  await page.getByLabel("Phương thức", { exact: true }).selectOption("cash");
  await expect(bars).toHaveCount(1);
  await expect(bars).toHaveAttribute("aria-label", /thu 600\.000/);
  await page
    .getByLabel("Nguồn thu", { exact: true })
    .selectOption("membership");
  await expect(bars).toHaveAttribute("aria-label", /thu 300\.000/);
  await expect(bars).toHaveCount(1);
});

test("daily income stays in one total column after source and method filters", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("thien-an-token", "chart-filter-test"),
  );
  await page.route("**/api/overview?**", (route) => {
    const filter = new URL(route.request().url()).searchParams;
    const amount =
      filter.get("category") === "membership"
        ? 300000
        : filter.get("method") === "cash"
          ? 600000
          : 1000000;
    return route.fulfill({
      json: {
        gross: amount,
        refunded: 0,
        net: amount,
        count: 2,
        daily: [{ date: "2026-11-25", income: amount, refund: 0 }],
        categories: { membership: 300000 },
        items: [],
        total: 0,
        page: 1,
        pages: 1,
      },
    });
  });
  await page.goto("/");
  const bars = page.locator(".bar:not(.refund-bar)");
  await expect(bars).toHaveCount(1);
  await expect(bars).toHaveAttribute("aria-label", /thu 1\.000\.000/);
  await page.getByLabel("Phương thức", { exact: true }).selectOption("cash");
  await expect(bars).toHaveAttribute("aria-label", /thu 600\.000/);
  await page
    .getByLabel("Nguồn thu", { exact: true })
    .selectOption("membership");
  await expect(bars).toHaveCount(1);
  await expect(bars).toHaveAttribute("aria-label", /thu 300\.000/);
  const size = await bars.boundingBox();
  expect(size?.height).toBeGreaterThan(100);
  expect(size?.width).toBeGreaterThan(0);
});
