import { useState, type FormEvent } from "react";

const GEMINI_KEY = "thien-an-gemini-api-key";
const FONT_KEY = "thien-an-admin-font";
const fonts = { small: "Nhỏ", normal: "Mặc định", large: "Lớn", xlarge: "Rất lớn" } as const;
type Font = keyof typeof fonts;

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function loadAdminFont(): Font {
  const value = read(FONT_KEY);
  return Object.hasOwn(fonts, value) ? value as Font : "normal";
}

function validKey(key: string) {
  return key.length > 0 && key.length <= 256 && !/[^\x21-\x7E]/.test(key);
}

function normalizeGeminiKey(value: string): string {
  const text = value.replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "").trim();
  return text.replace(/^(?:"(.*)"|'(.*)'|“(.*)”|‘(.*)’)$/, "$1$2$3$4").trim();
}

export function readGeminiKey(): string {
  const key = normalizeGeminiKey(read(GEMINI_KEY));
  return validKey(key) ? key : "";
}

export function AdminSettings({ font, onFontChange, onClose }: {
  font: Font;
  onFontChange: (font: Font) => void;
  onClose: () => void;
}) {
  const [selectedFont, setSelectedFont] = useState(font);
  const [key, setKey] = useState("");
  const [hasKey, setHasKey] = useState(() => Boolean(readGeminiKey()));
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const secure = window.isSecureContext;

  function save(event: FormEvent) {
    event.preventDefault();
    const value = normalizeGeminiKey(key);
    if (key.trim()) {
      if (!secure) {
        setError("Mở trang bằng HTTPS hoặc localhost để lưu khóa Gemini.");
        return;
      }
      if (!validKey(value)) {
        setError("Chỉ dán giá trị khóa API Gemini. Khóa không được chứa khoảng trắng hoặc ký tự không in được.");
        return;
      }
    }
    try {
      localStorage.setItem(FONT_KEY, selectedFont);
      if (value) localStorage.setItem(GEMINI_KEY, value);
      onFontChange(selectedFont);
      onClose();
    } catch {
      setError("Trình duyệt không lưu được cài đặt.");
    }
  }

  function removeKey() {
    try {
      localStorage.removeItem(GEMINI_KEY);
      setHasKey(false);
      setKey("");
      setError("");
      setNotice("Đã xóa khóa Gemini khỏi trình duyệt.");
    } catch {
      setError("Trình duyệt không xóa được khóa Gemini.");
    }
  }

  return (
    <form className="space-y-6" onSubmit={save}>
      <div className="space-y-2">
        <label>
          Khóa API Gemini
          <input type="password" value={key} onChange={(event) => {
            setKey(event.target.value);
            setError("");
          }} placeholder={hasKey ? "Đã lưu khóa · Nhập để thay thế" : "Dán khóa API Gemini"}
            autoComplete="off" spellCheck={false} maxLength={256} disabled={!secure}
            aria-describedby="gemini-key-help" />
        </label>
        <p className="muted text-sm" id="gemini-key-help">
          Khóa lưu trên trình duyệt này. Khi bạn dùng Trợ lý AI, câu hỏi và dữ liệu cần tra cứu có thể được gửi đến Gemini.
        </p>
        {!secure && <p className="muted text-sm">Mở trang bằng HTTPS hoặc localhost để dùng khóa đã lưu.</p>}
        {hasKey && <button type="button" onClick={removeKey}>Xóa khóa đã lưu</button>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <label>
        Cỡ chữ trang Admin
        <select value={selectedFont} onChange={(event) => setSelectedFont(event.target.value as Font)}>
          {Object.entries(fonts).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={onClose}>Hủy</button>
        <button type="submit" className="primary">Lưu cài đặt</button>
      </div>
    </form>
  );
}
