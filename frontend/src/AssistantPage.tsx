import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, ChatCircleDots, Plus, Stop } from "@phosphor-icons/react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Evidence = { tool: string; filters: Record<string, unknown>; partial: boolean };
type ToolCall = { index: number; name: string; result?: unknown };
type Message = { role: "user" | "assistant"; text: string; evidence?: Evidence[]; tools?: ToolCall[] };
type Update = (event: string, data: Record<string, unknown>) => void;
const encoder = new TextEncoder();
const examples = ["Tháng này đã thu bao nhiêu?", "So sánh tiền thu theo nguồn", "Các khoản hoàn tiền tuần này"];
const toolLabels: Record<string, string> = {
  summarize_income: "Tổng thu nhập",
  breakdown_income: "Phân bổ thu nhập",
  search_transactions: "Danh sách giao dịch",
  get_transaction: "Chi tiết giao dịch",
  search_refunds: "Danh sách hoàn tiền",
};
const filterLabels: Record<string, string> = {
  from: "Từ", to: "Đến", transaction_id: "Mã phiếu", category: "Nguồn thu",
  method: "Phương thức", status: "Trạng thái", group_by: "Nhóm theo",
};
const filterValues: Record<string, string> = {
  membership: "Gói hội viên", pt: "Huấn luyện cá nhân", class: "Lớp tập", retail: "Bán hàng",
  daily: "Theo ngày",
  cash: "Tiền mặt", transfer: "Chuyển khoản", card: "Thẻ",
  paid: "Đã thu", pending: "Chờ thanh toán", failed: "Thất bại",
  day: "Ngày", week: "Tuần", month: "Tháng", category: "Nguồn thu", method: "Phương thức",
};

function ToolCalls({ calls, running = false }: { calls: ToolCall[]; running?: boolean }) {
  return (
    <ol className="assistant-tools" aria-label="Các tool đã gọi">
      {calls.map(({ index, name, result }) => (
        <li key={index}>
          <details>
            <summary><code>{name}</code>{result === undefined && (
              <span className="muted"> · {running ? "Đang chạy…" : "Chưa có kết quả"}</span>
            )}</summary>
            {result !== undefined && <pre>{JSON.stringify(result, null, 2)}</pre>}
          </details>
        </li>
      ))}
    </ol>
  );
}

async function readEvents(response: Response, update: Update) {
  if (!response.body) throw new Error("Không nhận được phản hồi từ trợ lý.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      const frames = pending.split(/\r?\n\r?\n/);
      pending = frames.pop() ?? "";
      for (const frame of frames) {
        const lines = frame.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (event && data) update(event, JSON.parse(data));
        if (event === "done" || event === "error") return;
      }
    }
    throw new Error("Kết nối kết thúc trước khi trợ lý trả lời. Hãy thử lại.");
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function AssistantPage({
  active, api,
}: { active: boolean; api: (path: string, options?: RequestInit) => Promise<Response> }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [activeTools, setActiveTools] = useState<ToolCall[]>([]);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const inFlight = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const lastRequest = useRef<{ text: string; history: Message[] } | null>(null);
  useEffect(() => {
    if (active) input.current?.focus();
    return () => inFlight.current?.abort();
  }, [active]);
  useEffect(() => {
    const region = conversation.current;
    if (region) region.scrollTop = region.scrollHeight;
  }, [active, messages, activeTools, status, error]);

  async function ask(text: string, retry = false) {
    const clean = text.trim();
    if (!clean || encoder.encode(clean).length > 4000 || inFlight.current) return;
    const history = retry && lastRequest.current ? lastRequest.current.history : messages.slice(-12);
    lastRequest.current = { text: clean, history };
    const controller = new AbortController();
    const calls = new Map<number, ToolCall>();
    inFlight.current = controller;
    if (!retry) {
      setMessages((list) => [...list, { role: "user", text: clean }]);
      setDraft("");
    }
    setError("");
    setActiveTools([]);
    setStatus("Đang xử lý câu hỏi…");
    try {
      const response = await api("/assistant/chat", {
        method: "POST", signal: controller.signal,
        body: JSON.stringify({
          message: clean,
          history: history.map(({role, text}) => {
            // Drop incomplete trailing UTF-8 characters at the history byte boundary.
            const bytes = encoder.encode(text);
            return { role, text: bytes.length <= 4000 ? text : new TextDecoder().decode(bytes.slice(0, 3996)).replace(/\uFFFD$/, "") };
          }),
        }),
      });
      await readEvents(response, (event, data) => {
        if (controller.signal.aborted) return;
        const message = typeof data.message === "string" ? data.message : "";
        if (event === "status") setStatus(message);
        if ((event === "tool_start" || event === "tool_result") &&
            typeof data.index === "number" && typeof data.name === "string") {
          calls.set(data.index, { index: data.index, name: data.name, result: data.result });
          setActiveTools([...calls.values()]);
        }
        if (event === "error") throw new Error(message || "Không thể trả lời câu hỏi.");
        if (event === "done") {
          if (typeof data.text !== "string" || !data.text.trim()) {
            throw new Error("Trợ lý không trả về câu trả lời. Hãy thử lại.");
          }
          const answer = data.text;
          const evidence = Array.isArray(data.evidence) ? data.evidence as Evidence[] : [];
          setMessages((list) => [...list, { role: "assistant", text: answer, evidence, tools: [...calls.values()] }]);
          setActiveTools([]);
        }
      });
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Không thể kết nối trợ lý.");
      }
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setStatus("");
      }
    }
  }

  function stop() {
    inFlight.current?.abort();
    inFlight.current = null;
    setStatus("");
  }
  function reset() {
    stop();
    setMessages([]);
    setActiveTools([]);
    setDraft("");
    setError("");
    lastRequest.current = null;
    input.current?.focus();
  }
  const tooLong = encoder.encode(draft).length > 4000;
  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(draft);
  }

  return (
    <section hidden={!active} className="assistant-page" aria-label="Trợ lý AI">
      <header className="assistant-header">
        <button type="button" onClick={reset}><Plus size={16} aria-hidden="true" /> Cuộc trò chuyện mới</button>
      </header>
      <div className="assistant-conversation" ref={conversation} role="log" aria-label="Hội thoại">
        {messages.length === 0 && (
          <div className="assistant-empty">
            <span className="assistant-mark"><ChatCircleDots size={24} aria-hidden="true" /></span>
            <h2 className="heading-5">Bạn muốn tra cứu gì?</h2>
            <div className="assistant-prompts">
              {examples.map((example) => (
                <button type="button" key={example} onClick={() => {
                  setDraft(example);
                  input.current?.focus();
                }}>{example}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message, index) => (
          <article className={"assistant-message assistant-message-" + message.role} key={index}>
            <div className="assistant-speaker">{message.role === "user" ? "Bạn" : "Trợ lý Thiên Ân"}</div>
            {!!message.tools?.length && <ToolCalls calls={message.tools} />}
            <div className="assistant-text">
              {message.role === "assistant"
                ? <Markdown remarkPlugins={[remarkGfm]} disallowedElements={["img"]}>{message.text}</Markdown>
                : message.text}
            </div>
            {!!message.evidence?.length && (
              <details className="assistant-evidence">
                <summary>Dữ liệu đã tra cứu</summary>
                <ul>
                  {message.evidence.map(({ tool, filters, partial }, step) => (
                    <li key={step}>
                      <strong>{toolLabels[tool] ?? "Tra cứu"}</strong>
                      {Object.entries(filters).filter(([key, val]) => filterLabels[key] && typeof val === "string")
                        .map(([key, val]) => <span key={key}> · {filterLabels[key]} {filterValues[String(val)] ?? String(val)}</span>)}
                      {partial && <span> · Có thêm kết quả</span>}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </article>
        ))}
        {!!activeTools.length && <ToolCalls calls={activeTools} running={!!status} />}
        {status && <p className="muted" role="status">{status}</p>}
        {error && <div className="assistant-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => {
            if (lastRequest.current) void ask(lastRequest.current.text, true);
          }}>Thử lại</button>
        </div>}
      </div>
      <form className="assistant-composer" onSubmit={submit}>
        <textarea ref={input} aria-label="Tin nhắn" placeholder="Hỏi về thu nhập, giao dịch hoặc hoàn tiền" value={draft} rows={2}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void ask(draft);
            }
          }}
        />
        {status
          ? <button type="button" aria-label="Dừng trả lời" onClick={stop}><Stop size={18} aria-hidden="true" /></button>
          : <button className="primary" type="submit" aria-label="Gửi tin nhắn" disabled={!draft.trim() || tooLong}><ArrowUp size={18} aria-hidden="true" /></button>}
      </form>
      {tooLong && <p className="assistant-limit" role="alert">Tin nhắn quá dài. Hãy rút ngắn trước khi gửi.</p>}
    </section>
  );
}
