export function parseMoneyInput(value: FormDataEntryValue | null): number {
  return Number(String(value ?? "").replaceAll(".", ""));
}

export function MoneyInput({ max = 100_000_000_000 }: { max?: number }) {
  function format(input: HTMLInputElement) {
    const before = input.value;
    const digitsBeforeCaret = before
      .slice(0, input.selectionStart ?? before.length)
      .replace(/\D/g, "").length;
    const digits = before.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    input.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    const amount = Number(digits);
    input.setCustomValidity(
      digits && (amount < 1 || amount > max)
        ? `Số tiền phải từ 1 đến ${max.toLocaleString("vi-VN")} VND.`
        : "",
    );
    let caret = 0;
    let seen = 0;
    while (caret < input.value.length && seen < digitsBeforeCaret) {
      if (/\d/.test(input.value[caret])) seen++;
      caret++;
    }
    input.setSelectionRange(caret, caret);
  }
  return (
    <input
      name="amount"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      required
      onChange={(e) => format(e.currentTarget)}
      onKeyDown={(e) => {
        const input = e.currentTarget;
        const start = input.selectionStart ?? 0;
        if (
          start !== input.selectionEnd ||
          e.altKey ||
          e.ctrlKey ||
          e.metaKey ||
          e.shiftKey
        )
          return;
        if (e.key === "Backspace" && input.value[start - 1] === ".") {
          e.preventDefault();
          input.setRangeText("", start - 2, start, "end");
          format(input);
        } else if (e.key === "Delete" && input.value[start] === ".") {
          e.preventDefault();
          input.setRangeText("", start, start + 2, "start");
          format(input);
        }
      }}
    />
  );
}
