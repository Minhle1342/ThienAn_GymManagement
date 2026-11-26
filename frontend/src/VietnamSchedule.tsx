import { useState } from "react";

const vietnamClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function vietnamMinute(): string {
  return vietnamClock.format(new Date()).replace(" ", "T");
}

const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));

export function VietnamSchedule() {
  const [initial] = useState(vietnamMinute);
  const [day, setDay] = useState(initial.slice(0, 10));
  const [hour, setHour] = useState(initial.slice(11, 13));
  const [minute, setMinute] = useState(initial.slice(14, 16));

  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 font-medium">Thời điểm (giờ Việt Nam)</legend>
      <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2">
        <label className="min-w-0 text-sm">
          Ngày
          <input
            className="min-w-0 w-full"
            type="date"
            value={day}
            onChange={(event) => setDay(event.target.value)}
            required
          />
        </label>
        <label className="text-sm">
          Giờ
          <select aria-label="Giờ" value={hour} onChange={(event) => setHour(event.target.value)}>
            {hours.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
        <label className="text-sm">
          Phút
          <select aria-label="Phút" value={minute} onChange={(event) => setMinute(event.target.value)}>
            {minutes.map((value) => <option key={value}>{value}</option>)}
          </select>
        </label>
      </div>
      <input name="occurred_at" type="hidden" value={day ? `${day}T${hour}:${minute}` : ""} />
    </fieldset>
  );
}
