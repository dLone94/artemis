// Pure money-ledger domain. Persistence and time are supplied by callers.

import { stripSentinels } from "./untrusted.js";

const LEDGER_KINDS = new Set(["income", "expense", "bill", "debt", "goal"]);

function cleanLedgerText(value, limit) {
  return [...stripSentinels(typeof value === "string" ? value : "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()]
    .slice(0, limit)
    .join("");
}

function wholeNumberDigits(value) {
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function isDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function emptyEntries() {
  return { incomes: [], expenses: [], bills: [], debts: [], goals: [] };
}

function storedDigits(value) {
  return typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
    ? value
    : null;
}

function isoTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : null;
}

function sourceList(entries, key) {
  return entries && Array.isArray(entries[key]) ? entries[key] : [];
}

export function normalizeLedger(stored) {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return {
      version: 1,
      revision: 0,
      currency: null,
      entries: emptyEntries(),
      history: [],
      updatedAt: null
    };
  }
  const currency = /^[A-Za-z]{3}$/.test(String(stored.currency || ""))
    ? String(stored.currency).toUpperCase()
    : null;
  const entries = emptyEntries();
  const sourceEntries = stored.entries && typeof stored.entries === "object" &&
    !Array.isArray(stored.entries)
    ? stored.entries
    : {};

  if (currency) {
    for (const key of ["incomes", "expenses"]) {
      for (const candidate of sourceList(sourceEntries, key)) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
        const name = cleanLedgerText(candidate.name, 60);
        const amountDigits = storedDigits(candidate.amountDigits);
        const at = isoTimestamp(candidate.at);
        if (!name || amountDigits === null || !at) continue;
        entries[key].push({ name, amountDigits, at });
      }
    }

    for (const candidate of sourceList(sourceEntries, "bills")) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const name = cleanLedgerText(candidate.name, 60);
      const amountDigits = storedDigits(candidate.amountDigits);
      if (
        !name ||
        amountDigits === null ||
        !Number.isInteger(candidate.dueDay) ||
        candidate.dueDay < 1 ||
        candidate.dueDay > 28 ||
        candidate.cadence !== "monthly"
      ) {
        continue;
      }
      entries.bills.push({
        name,
        amountDigits,
        dueDay: candidate.dueDay,
        cadence: "monthly"
      });
    }

    for (const candidate of sourceList(sourceEntries, "debts")) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const name = cleanLedgerText(candidate.name, 60);
      const balanceDigits = storedDigits(candidate.balanceDigits);
      const hasMinimum = candidate.minPaymentDigits !== undefined;
      const minPaymentDigits = hasMinimum
        ? storedDigits(candidate.minPaymentDigits)
        : null;
      if (!name || balanceDigits === null || (hasMinimum && minPaymentDigits === null)) continue;
      const debt = { name, balanceDigits };
      if (hasMinimum) debt.minPaymentDigits = minPaymentDigits;
      entries.debts.push(debt);
    }

    for (const candidate of sourceList(sourceEntries, "goals")) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const name = cleanLedgerText(candidate.name, 60);
      const targetDigits = storedDigits(candidate.targetDigits);
      const savedDigits = storedDigits(candidate.savedDigits);
      const hasTargetDate = candidate.targetDate !== undefined;
      if (
        !name ||
        targetDigits === null ||
        savedDigits === null ||
        (hasTargetDate && !isDateKey(candidate.targetDate))
      ) {
        continue;
      }
      const goal = { name, targetDigits, savedDigits };
      if (hasTargetDate) goal.targetDate = candidate.targetDate;
      entries.goals.push(goal);
    }
  }

  const history = [];
  if (currency && Array.isArray(stored.history)) {
    for (const candidate of stored.history) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
      const at = isoTimestamp(candidate.at);
      const name = cleanLedgerText(candidate.name, 60);
      const summary = cleanLedgerText(candidate.summary, 500);
      if (!at || !LEDGER_KINDS.has(candidate.kind) || !name || !summary) continue;
      history.push({ at, kind: candidate.kind, name, summary });
    }
  }

  return {
    version: 1,
    revision: Number.isSafeInteger(stored.revision) && stored.revision >= 0
      ? stored.revision
      : 0,
    currency,
    entries,
    history,
    updatedAt: isoTimestamp(stored.updatedAt)
  };
}

export function validateLedgerChange(params, ledger, mapCurrency) {
  const currency = /^[A-Za-z]{3}$/.test(String(mapCurrency || ""))
    ? String(mapCurrency).toUpperCase()
    : null;
  if (!currency) {
    return { ok: false, message: "Set the Money Map planning currency first." };
  }
  if (
    params &&
    params.currency !== undefined &&
    (!/^[A-Za-z]{3}$/.test(String(params.currency)) ||
      String(params.currency).toUpperCase() !== currency)
  ) {
    return { ok: false, message: `All ledger amounts must stay in ${currency}.` };
  }
  const ledgerCurrency = /^[A-Za-z]{3}$/.test(String(ledger && ledger.currency || ""))
    ? String(ledger.currency).toUpperCase()
    : null;
  if (ledgerCurrency && ledgerCurrency !== currency) {
    return {
      ok: false,
      message: `The ledger uses ${ledgerCurrency}, but the Money Map uses ${currency}; nothing changed.`
    };
  }
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return { ok: false, message: "The ledger update must be one structured entry." };
  }
  const allowed = new Set([
    "kind",
    "name",
    "integer_value",
    "currency",
    "due_day",
    "cadence",
    "target_date",
    "saved_value",
    "min_payment_value",
    "raw_answer"
  ]);
  const extra = Object.keys(params).find((key) => !allowed.has(key));
  if (extra) return { ok: false, message: `Unknown ledger argument: ${extra}.` };
  if (!LEDGER_KINDS.has(params.kind)) {
    return { ok: false, message: "Choose income, expense, bill, debt, or goal." };
  }
  const name = cleanLedgerText(params.name, 60);
  if (!name) return { ok: false, message: "Give this ledger entry a name." };
  if (!cleanLedgerText(params.raw_answer, 500)) {
    return { ok: false, message: "Keep the user's original spoken entry in raw_answer." };
  }
  const amountDigits = wholeNumberDigits(params.integer_value);
  if (amountDigits === null) {
    return { ok: false, message: "The amount must be a non-negative safe whole number." };
  }

  const kindFields = {
    income: new Set(),
    expense: new Set(),
    bill: new Set(["due_day", "cadence"]),
    debt: new Set(["min_payment_value"]),
    goal: new Set(["target_date", "saved_value"])
  };
  const optionalFields = [
    "due_day",
    "cadence",
    "target_date",
    "saved_value",
    "min_payment_value"
  ];
  const incompatible = optionalFields.find(
    (field) => params[field] !== undefined && !kindFields[params.kind].has(field)
  );
  if (incompatible) {
    return { ok: false, message: `${params.kind} entries do not accept ${incompatible}.` };
  }

  if (
    params.kind === "bill" &&
    (!Number.isInteger(params.due_day) || params.due_day < 1 || params.due_day > 28)
  ) {
    return { ok: false, message: "A monthly bill due day must be a whole number from 1–28." };
  }
  if (params.kind === "bill" && params.cadence !== undefined && params.cadence !== "monthly") {
    return { ok: false, message: "Bills support monthly cadence only." };
  }

  if (params.kind === "income" || params.kind === "expense") {
    return { ok: true, kind: params.kind, entry: { name, amountDigits } };
  }
  if (params.kind === "bill") {
    return {
      ok: true,
      kind: "bill",
      entry: { name, amountDigits, dueDay: params.due_day, cadence: "monthly" }
    };
  }
  if (params.kind === "debt") {
    const entry = { name, balanceDigits: amountDigits };
    if (params.min_payment_value !== undefined) {
      const minPaymentDigits = wholeNumberDigits(params.min_payment_value);
      if (minPaymentDigits === null) {
        return {
          ok: false,
          message: "The minimum payment must be a non-negative safe whole number."
        };
      }
      entry.minPaymentDigits = minPaymentDigits;
    }
    return { ok: true, kind: "debt", entry };
  }

  const savedDigits = params.saved_value === undefined
    ? "0"
    : wholeNumberDigits(params.saved_value);
  if (savedDigits === null) {
    return { ok: false, message: "The saved amount must be a non-negative safe whole number." };
  }
  if (params.target_date !== undefined && !isDateKey(params.target_date)) {
    return { ok: false, message: "The goal target date must use a real YYYY-MM-DD date." };
  }
  const entry = { name, targetDigits: amountDigits, savedDigits };
  if (params.target_date !== undefined) entry.targetDate = params.target_date;
  return { ok: true, kind: "goal", entry };
}

function entryAmountDigits(kind, entry) {
  if (kind === "debt") return entry.balanceDigits;
  if (kind === "goal") return entry.targetDigits;
  return entry.amountDigits;
}

export function applyLedgerChange(ledger, validated, isoNow) {
  const current = normalizeLedger(ledger);
  const at = isoTimestamp(isoNow);
  if (!at) throw new TypeError("Ledger changes need a valid ISO timestamp.");
  if (!current.currency) throw new TypeError("Ledger changes need a planning currency.");
  if (
    !validated ||
    validated.ok !== true ||
    !LEDGER_KINDS.has(validated.kind) ||
    !validated.entry ||
    typeof validated.entry !== "object" ||
    Array.isArray(validated.entry)
  ) {
    throw new TypeError("Only a validated ledger change can be applied.");
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("The ledger revision cannot be incremented safely.");
  }

  const entry = { ...validated.entry };
  if (validated.kind === "income" || validated.kind === "expense") entry.at = at;
  const plural = {
    income: "incomes",
    expense: "expenses",
    bill: "bills",
    debt: "debts",
    goal: "goals"
  }[validated.kind];
  current.entries[plural].push(entry);
  current.history.push({
    at,
    kind: validated.kind,
    name: entry.name,
    summary:
      `Recorded ${validated.kind} ${entry.name} — ` +
      `${current.currency} ${entryAmountDigits(validated.kind, entry)}.`
  });
  current.revision += 1;
  current.updatedAt = at;
  return current;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

function calendarDate(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const year = value.getFullYear();
    const month = value.getMonth();
    const day = value.getDate();
    return { year, month, day, dayNumber: Date.UTC(year, month, day) / MILLISECONDS_PER_DAY };
  }
  if (!isDateKey(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return {
    year,
    month: month - 1,
    day,
    dayNumber: Date.UTC(year, month - 1, day) / MILLISECONDS_PER_DAY
  };
}

export function billsDueWithin(ledger, days, today) {
  if (!Number.isSafeInteger(days) || days < 0) return [];
  const currentDate = calendarDate(today);
  if (!currentDate) return [];
  const normalized = normalizeLedger(ledger);
  return normalized.entries.bills
    .map((bill, index) => {
      const monthOffset = bill.dueDay < currentDate.day ? 1 : 0;
      const dueDayNumber = Date.UTC(
        currentDate.year,
        currentDate.month + monthOffset,
        bill.dueDay
      ) / MILLISECONDS_PER_DAY;
      return {
        name: bill.name,
        amountDigits: bill.amountDigits,
        dueInDays: dueDayNumber - currentDate.dayNumber,
        index
      };
    })
    .filter((bill) => Number.isInteger(bill.dueInDays) && bill.dueInDays <= days)
    .sort((left, right) => left.dueInDays - right.dueInDays || left.index - right.index)
    .map(({ name, amountDigits, dueInDays }) => ({ name, amountDigits, dueInDays }));
}

function ceilDivide(dividend, divisor) {
  return dividend === 0n ? 0n : (dividend + divisor - 1n) / divisor;
}

export function goalPace(goal, today) {
  if (!goal || goal.targetDate === undefined) {
    return { onPace: null, weeklyNeedDigits: null };
  }
  const targetDigits = storedDigits(goal.targetDigits);
  const savedDigits = storedDigits(goal.savedDigits);
  const targetDate = calendarDate(goal.targetDate);
  const currentDate = calendarDate(today);
  if (targetDigits === null || savedDigits === null || !targetDate || !currentDate) {
    return { onPace: null, weeklyNeedDigits: null };
  }

  const target = BigInt(targetDigits);
  const saved = BigInt(savedDigits);
  if (saved >= target) return { onPace: true, weeklyNeedDigits: "0" };

  const daysUntilTarget = targetDate.dayNumber - currentDate.dayNumber;
  const positiveDays = BigInt(daysUntilTarget > 0 ? daysUntilTarget : 1);
  const weeksRemaining = ceilDivide(positiveDays, 7n);
  const weeklyNeed = ceilDivide(target - saved, weeksRemaining);
  return { onPace: false, weeklyNeedDigits: weeklyNeed.toString() };
}

export function suggestedActions(ledger, today, limit = 2) {
  const normalized = normalizeLedger(ledger);
  const requestedLimit = Number.isSafeInteger(limit) ? limit : 2;
  const cappedLimit = Math.max(0, Math.min(2, requestedLimit));
  if (!normalized.currency || cappedLimit === 0) return [];

  const actions = billsDueWithin(normalized, 7, today).map((bill) =>
    `${bill.name} is due in ${bill.dueInDays} days — ` +
    `${normalized.currency} ${bill.amountDigits}.`
  );
  const goalActions = normalized.entries.goals
    .map((goal, index) => ({ goal, pace: goalPace(goal, today), index }))
    .filter(({ pace }) => pace.onPace === false && pace.weeklyNeedDigits !== null)
    .sort((left, right) => {
      const needOrder = BigInt(right.pace.weeklyNeedDigits) -
        BigInt(left.pace.weeklyNeedDigits);
      return needOrder < 0n ? -1 : needOrder > 0n ? 1 : left.index - right.index;
    })
    .map(({ goal, pace }) =>
      `Setting aside ${normalized.currency} ${pace.weeklyNeedDigits} this week ` +
      `keeps ${goal.name} on pace.`
    );
  return [...actions, ...goalActions].slice(0, cappedLimit);
}
