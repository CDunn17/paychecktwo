export const DAY_MS = 86_400_000;

export function toLocalDate(value) {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function dateKey(date) {
  const d = toLocalDate(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function daysBetween(from, to) {
  return Math.max(0, Math.round((toLocalDate(to) - toLocalDate(from)) / DAY_MS));
}

export function billsThrough(bills, payday, today = new Date()) {
  const start = toLocalDate(today);
  const end = toLocalDate(payday);
  return bills.filter((bill) => {
    const due = toLocalDate(bill.due);
    return due >= start && due <= end;
  });
}

export function calculatePlan(plan, today = new Date()) {
  const upcoming = billsThrough(plan.bills, plan.payday, today);
  const billsTotal = upcoming.reduce((sum, bill) => sum + Number(bill.amount), 0);
  const safeToSpend = Math.max(0, Number(plan.balance) - billsTotal - Number(plan.buffer));
  const rawRemainder = Number(plan.balance) - billsTotal - Number(plan.buffer);
  const daysToPayday = daysBetween(today, plan.payday);
  const dailySafe = daysToPayday ? safeToSpend / daysToPayday : safeToSpend;
  return {
    upcoming,
    billsTotal,
    safeToSpend,
    rawRemainder,
    daysToPayday,
    dailySafe,
    afterPaycheck: Math.max(0, rawRemainder + Number(plan.paycheck))
  };
}

export function shiftDate(date, days) {
  const shifted = toLocalDate(date);
  shifted.setDate(shifted.getDate() + days);
  return dateKey(shifted);
}
