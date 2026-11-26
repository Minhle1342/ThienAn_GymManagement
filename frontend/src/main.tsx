import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ChartLineUp,
  ChatCircleDots,
  Wallet,
  ArrowDownLeft,
  Receipt,
  Plus,
  DownloadSimple,
  MagnifyingGlass,
  X,
  CaretLeft,
  CaretRight,
  SignOut,
  GearSix,
  Barbell,
  Funnel,
  CheckCircle,
  Clock,
  WarningCircle,
} from "@phosphor-icons/react";
import "./style.css";
import { AssistantPage } from "./AssistantPage";
import { AdminSettings, loadAdminFont, readGeminiKey } from "./AdminSettings";
import { VietnamSchedule } from "./VietnamSchedule";
import { MoneyInput, parseMoneyInput } from "./MoneyInput";

const categories: Record<string, string> = {
  membership: "Gói hội viên",
  pt: "Huấn luyện cá nhân",
  class: "Lớp tập",
  retail: "Bán hàng",
  daily: "Theo ngày",
};
const methods: Record<string, string> = {
  transfer: "Chuyển khoản",
  cash: "Tiền mặt",
  card: "Thẻ",
};
const statuses: Record<string, string> = {
  paid: "Đã thu",
  pending: "Chờ thanh toán",
  failed: "Thất bại",
};
const money = (n: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(
    n,
  );
const date = (s: string) =>
  new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Ho_Chi_Minh",
  }).format(new Date(s));
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
type Payment = {
  id: string;
  member: string;
  description: string;
  category: string;
  membership_months?: number | null;
  method: string;
  amount: number;
  status: string;
  occurred_at: string;
};
type Refund = {
  id: string;
  amount: number;
  reason: string;
  occurred_at: string;
};
type Overview = {
  gross: number;
  refunded: number;
  net: number;
  count: number;
  daily: { date: string; income: number; refund: number }[];
  categories: Record<string, number>;
  items: (Payment & { expires_on?: string; refunded_amount?: number })[];
  expired_memberships?: boolean;
  total: number;
  page: number;
  pages: number;
};
function App() {
  const [assistantOpen, setAssistantOpen] = useState(
    () => location.pathname === "/tro-ly-ai",
  );
  useEffect(() => {
    const sync = () => setAssistantOpen(location.pathname === "/tro-ly-ai");
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  function navigate(event: React.MouseEvent<HTMLAnchorElement>, open: boolean) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (open !== assistantOpen) {
      history.pushState(null, "", open ? "/tro-ly-ai" : "/");
      setAssistantOpen(open);
      window.scrollTo(0, 0);
    }
  }
  const [token, setToken] = useState(
    sessionStorage.getItem("thien-an-token") || "",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [adminFont, setAdminFont] = useState(loadAdminFont);
  useEffect(() => {
    if (!token) return;
    document.documentElement.dataset.adminFont = adminFont;
    return () => { delete document.documentElement.dataset.adminFont; };
  }, [token, adminFont]);
  const [secret, setSecret] = useState("");
  const [authError, setAuthError] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [filters, setFilters] = useState({
    from: today().slice(0, 7) + "-01",
    to: today(),
    category: "",
    method: "",
    status: "",
    q: "",
    page: 1,
    expired_memberships: "",
  });
  const showExpired = filters.expired_memberships === "true";
  const [data, setData] = useState<Overview | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  const listReady = showExpired === Boolean(data?.expired_memberships);
  const listUnit = showExpired ? "hội viên" : "giao dịch";
  const [modal, setModal] = useState(false),
    [selected, setSelected] = useState<{
      payment: Payment;
      refunds: Refund[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [formError, setFormError] = useState("");
  const paymentKey = useRef(""),
    refundKey = useRef("");
  const detailRequest = useRef(0);
  const query = new URLSearchParams(
    Object.entries(filters)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => [key, String(value)]),
  ).toString();
  async function api(path: string, options: RequestInit = {}) {
    const headers = new Headers(options.headers);
    headers.set("Authorization", "Bearer " + token);
    headers.set("Content-Type", "application/json");
    if (path === "/assistant/chat" && window.isSecureContext) {
      const key = readGeminiKey();
      if (key) headers.set("X-Thien-An-Gemini-Key", key);
    }
    const res = await fetch("/api" + path, {
      ...options,
      headers,
    });
    if (res.status === 401) {
      sessionStorage.removeItem("thien-an-token");
      setToken("");
      setSettingsOpen(false);
      throw new Error("Mã truy cập không hợp lệ hoặc đã thay đổi.");
    }
    if (!res.ok) throw new Error(await res.text());
    return res;
  }
  useEffect(() => {
    if (!token || assistantOpen) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(() => {
      api("/overview?" + query, { signal: controller.signal })
        .then((r) => r.json())
        .then(setData)
        .catch((e) => {
          if (e.name !== "AbortError") setError(e.message);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [token, query, reload, assistantOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  function change(k: string, v: string) {
    setFilters((f) => ({ ...f, [k]: v, page: 1 }));
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setConnecting(true);
    setAuthError("");
    try {
      const r = await fetch("/api/overview", {
        headers: { Authorization: "Bearer " + secret },
      });
      if (!r.ok)
        throw new Error(
          r.status === 401
            ? "Mã truy cập chưa đúng. Vui lòng kiểm tra lại."
            : "Không thể kết nối máy chủ.",
        );
      sessionStorage.setItem("thien-an-token", secret);
      setToken(secret);
      setSecret("");
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : "Không thể kết nối.");
    } finally {
      setConnecting(false);
    }
  }
  async function openDetail(id: string) {
    const request = ++detailRequest.current;
    setFormError("");
    try {
      const response = await api("/transactions/" + id, { cache: "no-store" });
      const detail = await response.json();
      if (request !== detailRequest.current) return;
      setSelected(detail);
      refundKey.current = crypto.randomUUID();
    } catch (e) {
      if (request === detailRequest.current) setError((e as Error).message);
    }
  }
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const occurredAt = String(form.get("occurred_at") ?? "");
    const months = form.get("membership_months");
    if (!occurredAt) {
      setFormError("Chọn ngày, giờ và phút của khoản thu.");
      return;
    }
    setBusy(true);
    setFormError("");
    try {
      const payload = {
        ...Object.fromEntries(form),
        amount: parseMoneyInput(form.get("amount")),
        membership_months: months ? Number(months) : undefined,
        occurred_at: new Date(occurredAt + "+07:00").toISOString(),
        idempotency_key: paymentKey.current,
      };
      await api("/transactions", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setModal(false);
      setNotice("Đã ghi nhận khoản thu.");
      setReload((x) => x + 1);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function saveRefund(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setFormError("");
    try {
      await api("/transactions/" + selected.payment.id + "/refunds", {
        method: "POST",
        body: JSON.stringify({
          amount: parseMoneyInput(f.get("amount")),
          reason: f.get("reason"),
          idempotency_key: refundKey.current,
        }),
      });
      setSelected(null);
      setNotice("Đã ghi nhận hoàn tiền.");
      setReload((x) => x + 1);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function settle() {
    if (!selected) return;
    setBusy(true);
    setFormError("");
    try {
      await api("/transactions/" + selected.payment.id + "/settle", {
        method: "POST",
      });
      setSelected(null);
      setNotice("Đã xác nhận thanh toán.");
      setReload((x) => x + 1);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    try {
      const res = await api("/export?" + query);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = "thien-an-thu-nhap.csv";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!token)
    return (
      <main className="login">
        <form onSubmit={login} className="login-card">
          <Brand />
          <div className="mt-8">
            <h1 className="heading-5">Chào mừng trở lại</h1>
            <p className="muted mt-2">
              Truy cập không gian quản lý thu nhập Thiên Ân.
            </p>
          </div>
          <label className="mt-8">
            Mã truy cập quản trị
            <input
              autoFocus
              type="password"
              required
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {authError && (
            <p role="alert" className="error">
              {authError}
            </p>
          )}
          <button className="primary w-full mt-6" disabled={connecting}>
            {connecting ? "Đang kết nối…" : "Đăng nhập"}
          </button>
          <p className="muted text-sm mt-6">
            Sử dụng mã truy cập được cấu hình bởi quản trị viên.
          </p>
        </form>
      </main>
    );
  const remaining = selected
    ? selected.payment.amount -
      selected.refunds.reduce((s, r) => s + r.amount, 0)
    : 0;
  const navigation = (
    <>
      <a href="/" aria-current={assistantOpen ? undefined : "page"} onClick={(event) => navigate(event, false)}>
        <ChartLineUp size={20} aria-hidden="true" /> Thu nhập
      </a>
      <a href="/tro-ly-ai" aria-current={assistantOpen ? "page" : undefined} onClick={(event) => navigate(event, true)}>
        <ChatCircleDots size={20} aria-hidden="true" /> Trợ lý AI
      </a>
    </>
  );
  return (
    <>
      <a className="skip" href="#main">
        Đến nội dung chính
      </a>
      <aside className="sidebar">
        <Brand />
        <p className="nav-label">TÀI CHÍNH</p>
        <nav aria-label="Điều hướng chính">
          {navigation}
        </nav>
        <div className="sidebar-bottom">
          <button type="button" onClick={() => setSettingsOpen(true)}>
            <GearSix size={18} aria-hidden="true" /> Cài đặt
          </button>
          <button
            onClick={() => {
              sessionStorage.removeItem("thien-an-token");
              setToken("");
              setSettingsOpen(false);
              setData(null);
            }}
          >
            <SignOut size={18} /> Đăng xuất
          </button>
        </div>
      </aside>
      <div className="app">
        <header className="topbar">
          <span className="desktop-breadcrumb">
            Tài chính <span className="muted mx-2">/</span>{" "}
            <strong>{assistantOpen ? "Trợ lý AI" : "Thu nhập"}</strong>
          </span>
          <nav className="mobile-navigation" aria-label="Điều hướng di động">{navigation}</nav>
          <button className="mobile-settings" type="button" aria-label="Cài đặt" onClick={() => setSettingsOpen(true)}>
            <GearSix size={20} aria-hidden="true" />
          </button>
          <span className="profile">
            <span className="avatar">TA</span>
            <span>Quản trị viên</span>
          </span>
        </header>
        <main id="main">
          <AssistantPage active={assistantOpen} api={api} />
          {!assistantOpen && <>
          <div className="page-heading">
            <div>
              <h1 className="heading-4">Quản lý thu nhập</h1>
              <p className="muted mt-2">
                Bức tranh tài chính của Thiên Ân, trong một không gian.
              </p>
            </div>
            <div className="actions">
              <button disabled={busy || loading} onClick={download}>
                <DownloadSimple size={18} />
                Xuất dữ liệu
              </button>
              <button
                className="primary"
                onClick={() => {
                  paymentKey.current = crypto.randomUUID();
                  setFormError("");
                  setModal(true);
                }}
              >
                <Plus size={18} />
                Ghi nhận khoản thu
              </button>
            </div>
          </div>
          <section className="filters" aria-label="Bộ lọc thu nhập">
            <DateRange from={filters.from} to={filters.to} onChange={change} />
            <Select
              label="Nguồn thu"
              value={filters.category}
              onChange={(v) => change("category", v)}
              options={categories}
            />
            <Select
              label="Phương thức"
              value={filters.method}
              onChange={(v) => change("method", v)}
              options={methods}
            />
            <button
              className="text-button"
              onClick={() =>
                setFilters({
                  from: today().slice(0, 7) + "-01",
                  to: today(),
                  category: "",
                  method: "",
                  status: "",
                  q: "",
                  page: 1,
                  expired_memberships: "",
                })
              }
            >
              Đặt lại
            </button>
          </section>
          {notice && (
            <p role="status" className="notice">
              <CheckCircle size={20} />
              {notice}
            </p>
          )}
          {error && (
            <div className="error" role="alert">
              {error}
              <button onClick={() => setReload((x) => x + 1)}>Thử lại</button>
            </div>
          )}
          {loading && !data ? (
            <div className="skeleton" aria-label="Đang tải dữ liệu" />
          ) : (
            data && (
              <div aria-busy={loading} className={loading ? "refreshing" : ""}>
                <section className="stats" aria-label="Tổng quan">
                  <Stat
                    label="Thu nhập ròng"
                    value={data.net}
                    icon={<Wallet />}
                    note="Tiền đã thu trừ hoàn tiền"
                    featured
                  />
                  <Stat
                    label="Tổng tiền đã thu"
                    value={data.gross}
                    icon={<ChartLineUp />}
                    note="Chỉ tính giao dịch đã thu"
                  />
                  <Stat
                    label="Đã hoàn tiền"
                    value={data.refunded}
                    icon={<ArrowDownLeft />}
                    note="Theo ngày thực hiện hoàn"
                  />
                  <Stat
                    label="Giao dịch thành công"
                    value={data.count}
                    icon={<Receipt />}
                    note="Trong khoảng ngày đã chọn"
                    count
                  />
                </section>
                <div className="charts">
                  <section className="panel trend">
                    <div className="panel-heading">
                      <div>
                        <h2 className="title-1">Dòng thu nhập</h2>
                        <p className="muted text-sm mt-1">
                          Tiền thu và hoàn theo ngày giao dịch
                        </p>
                      </div>
                      <span className="legend">
                        <span>
                          <i />
                          Tiền thu
                        </span>
                        <span>
                          <i className="refund-dot" />
                          Hoàn tiền
                        </span>
                      </span>
                    </div>
                    <Chart daily={data.daily} />
                  </section>
                  <section className="panel">
                    <h2 className="title-1">Nguồn thu</h2>
                    <p className="muted text-sm mt-1">
                      Cơ cấu tổng tiền đã thu
                    </p>
                    <div className="category-list">
                      {Object.entries(categories).map(([k, v], i) => {
                        const amount = data.categories[k] || 0;
                        const percent = data.gross
                          ? (amount / data.gross) * 100
                          : 0;
                        return (
                          <div key={k}>
                            <div className="flex justify-between gap-2">
                              <span>{v}</span>
                              <strong>{Math.round(percent)}%</strong>
                            </div>
                            <div className="track">
                              <span
                                style={{
                                  width: percent + "%",
                                  background: [
                                    "#111111",
                                    "#6b7280",
                                    "#a1a1aa",
                                    "#d1d5db",
                                    "#52525b",
                                  ][i],
                                }}
                              />
                            </div>
                            <p className="muted text-sm">{money(amount)}</p>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                </div>
                <section className="panel transactions">
                  <div className="table-heading">
                    <div>
                      <h2 className="title-1">
                        {showExpired ? "Hội viên hết hạn" : "Lịch sử giao dịch"}{" "}
                        {listReady && (
                          <span className="total-badge">{data.total}</span>
                        )}
                      </h2>
                      <p className="muted text-sm mt-1">
                        {showExpired
                          ? "Ngày hết hạn tính từ thời điểm giao dịch cộng số tháng của gói."
                          : "Quản lý từng khoản thu của trung tâm."}
                      </p>
                    </div>
                  </div>
                  <div className="table-tools">
                    {!showExpired && (
                      <DateRange
                        from={filters.from}
                        to={filters.to}
                        onChange={change}
                        labelSuffix=" giao dịch"
                      />
                    )}
                    <div className="search">
                      <MagnifyingGlass size={18} className="shrink-0" />
                      <input
                        aria-label="Tìm giao dịch"
                        placeholder="Tìm tên, nội dung, mã phiếu…"
                        value={filters.q}
                        onChange={(e) => change("q", e.target.value)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      <Select
                        label="Trạng thái"
                        value={showExpired ? "paid" : filters.status}
                        onChange={(v) => change("status", v)}
                        options={statuses}
                        disabled={showExpired}
                      />
                      <button
                        type="button"
                        aria-pressed={showExpired}
                        className={showExpired ? "primary" : undefined}
                        onClick={() => change("expired_memberships", showExpired ? "" : "true")}
                      >
                        Hội viên hết hạn
                      </button>
                    </div>
                  </div>
                  {!listReady ? (
                    loading && <div className="skeleton" aria-label="Đang tải danh sách" />
                  ) : data.items.length ? (
                    <>
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>Giao dịch / Hội viên</th>
                              <th>Nguồn thu</th>
                              <th>{showExpired ? "Ngày hết hạn" : "Thời điểm"}</th>
                              <th>Phương thức</th>
                              <th>Trạng thái</th>
                              <th className="amount">Số tiền</th>
                            </tr>
                          </thead>
                          <tbody>
                            {data.items.map((p) => (
                              <tr key={p.id}>
                                <td>
                                  <button
                                    className="row-link"
                                    onClick={() => openDetail(p.id)}
                                  >
                                    <strong>{p.member}</strong>
                                    <span>{p.description}</span>
                                    <small>{p.id}</small>
                                  </button>
                                </td>
                                <td>{categories[p.category]}</td>
                                <td>{p.expires_on ? p.expires_on.split("-").reverse().join("/") : date(p.occurred_at)}</td>
                                <td>{methods[p.method]}</td>
                                <td>
                                  <span className={"badge " + p.status}>
                                    {p.status === "paid" ? (
                                      <CheckCircle />
                                    ) : p.status === "pending" ? (
                                      <Clock />
                                    ) : (
                                      <WarningCircle />
                                    )}
                                    {statuses[p.status]}
                                  </span>
                                </td>
                                <td className="amount">
                                  <TransactionAmount amount={p.amount} refunded={p.refunded_amount} />
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div className="mobile-transactions">
                        {data.items.map((p) => (
                          <button
                            className="mobile-payment"
                            key={p.id}
                            onClick={() => openDetail(p.id)}
                          >
                            <span className="flex justify-between gap-3">
                              <strong>{p.member}</strong>
                              <span className="shrink-0 text-right tabular-nums">
                                <TransactionAmount amount={p.amount} refunded={p.refunded_amount} />
                              </span>
                            </span>
                            <span className="muted">{p.description}</span>
                            <span className="muted text-xs">{categories[p.category]}</span>
                            <span className="flex justify-between gap-2 items-center">
                              <span className="muted text-xs">
                                {p.expires_on ? `Hết hạn ${p.expires_on.split("-").reverse().join("/")}` : date(p.occurred_at)}
                                <br />
                                {methods[p.method]}
                              </span>
                              <span className={"badge " + p.status}>
                                {statuses[p.status]}
                              </span>
                            </span>
                            <span className="muted text-xs">{p.id}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="empty">
                      <Receipt size={36} />
                      <h3 className="title-2">{showExpired ? "Không có hội viên hết hạn phù hợp" : "Chưa có giao dịch phù hợp"}</h3>
                      {!showExpired && (
                        <p className="muted">Thử thay đổi bộ lọc hoặc ghi nhận khoản thu đầu tiên.</p>
                      )}
                    </div>
                  )}
                  {listReady && <div className="pagination">
                    <span className="muted">
                      {data.total
                        ? `${(data.page - 1) * 10 + 1}–${Math.min(data.page * 10, data.total)} trong ${data.total} ${listUnit}`
                        : `0 ${listUnit}`}
                    </span>
                    <div>
                      <button
                        aria-label="Trang trước"
                        disabled={data.page <= 1 || loading}
                        onClick={() =>
                          setFilters((f) => ({ ...f, page: data.page - 1 }))
                        }
                      >
                        <CaretLeft />
                      </button>
                      <span>
                        Trang {data.page} / {data.pages}
                      </span>
                      <button
                        aria-label="Trang sau"
                        disabled={data.page >= data.pages || loading}
                        onClick={() =>
                          setFilters((f) => ({ ...f, page: data.page + 1 }))
                        }
                      >
                        <CaretRight />
                      </button>
                    </div>
                  </div>}
                </section>
              </div>
            )
          )}
          <footer>
            <Brand compact />
            <span>Không gian tài chính · Trung tâm thể hình Thiên Ân</span>
          </footer>
          </>}
        </main>
      </div>
      {settingsOpen && (
        <Modal title="Cài đặt" onClose={() => setSettingsOpen(false)}>
          <AdminSettings font={adminFont} onFontChange={setAdminFont} onClose={() => setSettingsOpen(false)} />
        </Modal>
      )}
      {modal && (
        <Modal
          title="Ghi nhận khoản thu"
          onClose={() => !busy && setModal(false)}
        >
          <form onSubmit={save}>
            <div className="form-grid">
              <label>
                Hội viên
                <input
                  name="member"
                  required
                  maxLength={120}
                  autoFocus
                  placeholder="Họ và tên hội viên"
                />
              </label>
              <IncomeSourceFields />
              <label className="full">
                Nội dung
                <input
                  name="description"
                  required
                  maxLength={500}
                  placeholder="Ví dụ: Gói hội viên 3 tháng"
                />
              </label>
              <label>
                Số tiền (VND)
                <MoneyInput />
              </label>
              <label>
                Phương thức
                <select name="method">
                  {Object.entries(methods).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <VietnamSchedule />
              <label>
                Trạng thái
                <select name="status">
                  {Object.entries(statuses).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {formError && (
              <p role="alert" className="error">
                {formError}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() => setModal(false)}
              >
                Hủy
              </button>
              <button className="primary" disabled={busy}>
                {busy ? "Đang lưu…" : "Lưu khoản thu"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {selected && (
        <Modal
          title="Chi tiết giao dịch"
          onClose={() => !busy && setSelected(null)}
        >
          <div className="detail-amount">{money(selected.payment.amount)}</div>
          <p className="muted">{selected.payment.id}</p>
          <dl className="details">
            {[
              ["Hội viên", selected.payment.member],
              ["Nội dung", selected.payment.description],
              ["Nguồn thu", categories[selected.payment.category]],
              ["Phương thức", methods[selected.payment.method]],
              ["Trạng thái", statuses[selected.payment.status]],
              ["Thời điểm", date(selected.payment.occurred_at)],
              ["Đã hoàn", money(selected.payment.amount - remaining)],
            ].map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
            {selected.payment.category === "membership" && (
              <div>
                <dt>Tổng tháng</dt>
                <dd>
                  {selected.payment.membership_months == null
                    ? "Chưa nhập cho giao dịch này"
                    : `${selected.payment.membership_months} tháng`}
                </dd>
              </div>
            )}
          </dl>
          {selected.refunds.map((r) => (
            <div className="refund-entry" key={r.id}>
              <strong>Hoàn {money(r.amount)}</strong>
              <p>{r.reason}</p>
              <small className="muted">{date(r.occurred_at)}</small>
            </div>
          ))}
          {selected.payment.status === "pending" && (
            <div>
              <p className="muted mb-4">
                Chỉ xác nhận khi đã nhận tiền. Khoản thu sẽ được ghi nhận vào
                thời điểm xác nhận.
              </p>
              {formError && (
                <p role="alert" className="error">
                  {formError}
                </p>
              )}
              <button className="primary" disabled={busy} onClick={settle}>
                {busy ? "Đang lưu…" : "Xác nhận đã thu"}
              </button>
            </div>
          )}
          {selected.payment.status === "paid" && remaining > 0 && (
            <form onSubmit={saveRefund}>
              <h3 className="title-2 mb-4">Ghi nhận hoàn tiền</h3>
              <label>
                Số tiền hoàn (tối đa {money(remaining)})
                <MoneyInput max={remaining} />
              </label>
              <label className="mt-4">
                Lý do hoàn
                <input name="reason" required maxLength={500} />
              </label>
              {formError && (
                <p role="alert" className="error">
                  {formError}
                </p>
              )}
              <button className="primary mt-4" disabled={busy}>
                {busy ? "Đang lưu…" : "Xác nhận hoàn tiền"}
              </button>
            </form>
          )}
        </Modal>
      )}
    </>
  );
}
function TransactionAmount({ amount, refunded = 0 }: { amount: number; refunded?: number }) {
  return (
    <>
      <strong>{money(amount)}</strong>
      {refunded > 0 && <span className="muted block text-xs">Đã hoàn {money(refunded)}</span>}
    </>
  );
}

const membershipMonthPresets = ["1", "3", "6", "12"];

function IncomeSourceFields() {
  const [category, setCategory] = useState("membership");
  const [months, setMonths] = useState("");
  return (
    <>
      <label>
        Nguồn thu
        <select name="category" value={category} onChange={(event) => setCategory(event.target.value)}>
          {Object.entries(categories).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </label>
      {category === "membership" && (
        <>
          <label>
            Tổng tháng
            <input
              name="membership_months"
              type="number"
              min={1}
              max={Number.MAX_SAFE_INTEGER}
              step={1}
              inputMode="numeric"
              value={months}
              onChange={(event) => setMonths(event.target.value)}
              placeholder="Nhập số tháng"
            />
          </label>
          <label>
            Chọn nhanh số tháng
            <select
              value={membershipMonthPresets.includes(months) ? months : ""}
              onChange={(event) => setMonths(event.target.value)}
            >
              <option value="">Chọn mốc có sẵn</option>
              {membershipMonthPresets.map((value) => (
                <option key={value} value={value}>{value} tháng</option>
              ))}
            </select>
          </label>
        </>
      )}
    </>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={"brand " + (compact ? "compact" : "")}>
      <span className="brand-mark">
        <Barbell size={24} weight="bold" />
      </span>
      <div>
        <strong>
          thiên ân<span>.</span>
        </strong>
        {!compact && <small>FITNESS & WELLNESS</small>}
      </div>
    </div>
  );
}
function DateRange({
  from,
  to,
  onChange,
  labelSuffix = "",
}: {
  from: string;
  to: string;
  onChange: (key: "from" | "to", value: string) => void;
  labelSuffix?: string;
}) {
  return (
    <div className="date-range">
      <Funnel size={18} aria-hidden="true" />
      <label>
        Từ ngày
        <input
          aria-label={"Từ ngày" + labelSuffix}
          type="date"
          value={from}
          onChange={(event) => onChange("from", event.target.value)}
        />
      </label>
      <span className="muted" aria-hidden="true">đến</span>
      <label>
        Đến ngày
        <input
          aria-label={"Đến ngày" + labelSuffix}
          type="date"
          value={to}
          onChange={(event) => onChange("to", event.target.value)}
        />
      </label>
    </div>
  );
}

function Select({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Record<string, string>;
  disabled?: boolean;
}) {
  return (
    <select
      aria-label={label}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{label}: Tất cả</option>
      {Object.entries(options).map(([k, v]) => (
        <option key={k} value={k}>
          {v}
        </option>
      ))}
    </select>
  );
}
function Stat({
  label,
  value,
  icon,
  note,
  featured = false,
  count = false,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  note: string;
  featured?: boolean;
  count?: boolean;
}) {
  return (
    <article className={"stat " + (featured ? "featured" : "")}>
      <div className="stat-label">
        {label}
        <span>{icon}</span>
      </div>
      <p className="stat-value">
        {count ? value.toLocaleString("vi-VN") : money(value)}
      </p>
      <p className="muted text-sm">{note}</p>
    </article>
  );
}
function Chart({ daily: rows }: { daily: Overview["daily"] }) {
  const [activeDate, setActiveDate] = useState<string | null>(null);
  const totals = new Map<string, Overview["daily"][number]>();
  for (const row of rows) {
    const total = totals.get(row.date) ?? {
      date: row.date,
      income: 0,
      refund: 0,
    };
    total.income += row.income;
    total.refund += row.refund;
    totals.set(row.date, total);
  }
  const daily = [...totals.values()].sort((a, b) => a.date.localeCompare(b.date));
  const active = activeDate ? totals.get(activeDate) : undefined;
  if (!daily.length)
    return (
      <div className="chart-empty muted">
        Chưa có khoản thu hoặc hoàn tiền trong kỳ này.
      </div>
    );
  const max = daily.reduce(
    (peak, day) => Math.max(peak, day.income, day.refund),
    1,
  );
  return (
    <div className="chart-area">
      <div className="axis">
        {[1, 0.75, 0.5, 0.25, 0].map((v) => (
          <span key={v}>
            {new Intl.NumberFormat("vi-VN", {
              notation: "compact",
              maximumFractionDigits: 1,
            }).format(max * v)}
          </span>
        ))}
      </div>
      <div className="plot">
        <div className="grid-lines">
          {[0, 1, 2, 3, 4].map((i) => (
            <i key={i} />
          ))}
        </div>
        <div className="bars">
          {daily.map((d) => (
            <div
              className="bar-group"
              key={d.date}
              onMouseEnter={() => setActiveDate(d.date)}
              onMouseLeave={() => setActiveDate(null)}
              onFocus={() => setActiveDate(d.date)}
              onBlur={() => setActiveDate(null)}
            >
              <div className="bar-pair">
                <div
                  className="bar"
                  style={{
                    height:
                      Math.max((d.income / max) * 100, d.income ? 1 : 0) + "%",
                  }}
                  tabIndex={d.income > 0 ? 0 : undefined}
                  aria-label={`${d.date}: thu ${money(d.income)}, hoàn ${money(d.refund)}`}
                />
                {d.refund > 0 && (
                  <div
                    className="bar refund-bar"
                    style={{ height: (d.refund / max) * 100 + "%" }}
                    tabIndex={d.income === 0 ? 0 : undefined}
                    aria-label={`${d.date}: hoàn ${money(d.refund)}`}
                  />
                )}
              </div>
              <small>{d.date.slice(8)}/{d.date.slice(5, 7)}</small>
            </div>
          ))}
        </div>
        {active && (
          <div className="tooltip" aria-hidden="true">
            <div>{active.date}</div>
            <div>Thu {money(active.income)}</div>
            <div>Hoàn {money(active.refund)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="modal-heading">
        <h2 id="dialog-title" className="heading-6">
          {title}
        </h2>
        <button aria-label="Đóng" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
