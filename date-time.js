const BUSINESS_TIME_ZONE =
  process.env.BUSINESS_TIME_ZONE || "Africa/Addis_Ababa";

function getDateTimeParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
}

function formatLocalDateTime(timestamp, timeZone = BUSINESS_TIME_ZONE) {
  const date = new Date(`${timestamp.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return timestamp;

  const parts = getDateTimeParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ` +
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`
  );
}

function localMidnightAsUtc(year, month, day, timeZone) {
  const targetAsUtc = Date.UTC(year, month - 1, day);
  let timestamp = targetAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = getDateTimeParts(new Date(timestamp), timeZone);
    const representedAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const adjustment = targetAsUtc - representedAsUtc;
    timestamp += adjustment;
    if (adjustment === 0) break;
  }

  return new Date(timestamp);
}

function toSqliteUtc(date) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function getLocalDayRange(now = new Date(), timeZone = BUSINESS_TIME_ZONE) {
  const { year, month, day } = getDateTimeParts(now, timeZone);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const start = localMidnightAsUtc(year, month, day, timeZone);
  const end = localMidnightAsUtc(
    nextDay.getUTCFullYear(),
    nextDay.getUTCMonth() + 1,
    nextDay.getUTCDate(),
    timeZone
  );

  return [toSqliteUtc(start), toSqliteUtc(end)];
}

module.exports = {
  BUSINESS_TIME_ZONE,
  formatLocalDateTime,
  getLocalDayRange,
};
