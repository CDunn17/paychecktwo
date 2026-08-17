import { calculatePlan, dateKey, shiftDate, toLocalDate } from "./src/plan.js";

const STORAGE_KEY = "paycheck-two-plan-v1";
const SESSION_KEY = "paycheck-two-session-v1";
const today = new Date();

const seedPlan = {
  name: "Alex",
  balance: 642.18,
  paycheck: 1840,
  buffer: 100,
  payday: shiftDate(today, 8),
  periodStart: shiftDate(today, -6),
  bills: [
    { id: crypto.randomUUID(), name: "Phone bill", amount: 74, due: shiftDate(today, 1), category: "Utilities", icon: "phone" },
    { id: crypto.randomUUID(), name: "Groceries", amount: 95, due: shiftDate(today, 3), category: "Food", icon: "cart" },
    { id: crypto.randomUUID(), name: "Car insurance", amount: 126, due: shiftDate(today, 6), category: "Transport", icon: "car" }
  ]
};

let plan = loadPlan();
let dialogMode = "plan";
const sessionId = loadSessionId();

const $ = (selector) => document.querySelector(selector);
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const friendlyDate = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric" });
const shortDate = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" });

function loadPlan() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (stored?.bills && stored?.payday && toLocalDate(stored.payday) >= toLocalDate(today)) return stored;
  } catch (error) {
    console.warn("Could not restore saved plan", error);
  }
  return seedPlan;
}

function loadSessionId() {
  const stored = localStorage.getItem(SESSION_KEY);
  if (stored) return stored;
  const created = `demo-${crypto.randomUUID()}`;
  localStorage.setItem(SESSION_KEY, created);
  return created;
}

function savePlan() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
}

function iconFor(type) {
  const icons = {
    phone: '<svg viewBox="0 0 24 24"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10 18.5h4"/></svg>',
    cart: '<svg viewBox="0 0 24 24"><path d="M3 4h2l2.2 10h10.6l2-7H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/></svg>',
    car: '<svg viewBox="0 0 24 24"><path d="m5 10 2-5h10l2 5M4 10h16v7H4z"/><path d="M7 17v2M17 17v2M7 13h2M15 13h2"/></svg>',
    home: '<svg viewBox="0 0 24 24"><path d="m3 11 9-8 9 8v10h-6v-6H9v6H3z"/></svg>',
    other: '<svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h3"/></svg>'
  };
  return icons[type] || icons.other;
}

function billIcon(category) {
  return ({ Utilities: "phone", Food: "cart", Transport: "car", Home: "home" })[category] || "other";
}

function render() {
  const summary = calculatePlan(plan, today);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  $("h1").textContent = `${greeting}, ${plan.name}.`;
  $("#today-label").textContent = `YOUR PLAN FOR ${new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(today).toUpperCase()}`;
  $("#safe-to-spend").textContent = money.format(summary.safeToSpend);
  $("#days-count").textContent = summary.daysToPayday;
  $("#current-balance").textContent = money.format(plan.balance);
  $("#bills-before-payday").textContent = `−${money.format(summary.billsTotal)}`;
  $("#safety-buffer").textContent = `−${money.format(plan.buffer)}`;
  $("#next-payday").textContent = friendlyDate.format(toLocalDate(plan.payday));
  $("#paycheck-amount").textContent = money.format(plan.paycheck);
  $("#after-paycheck").textContent = `${money.format(summary.afterPaycheck)} available`;

  const totalPeriod = Math.max(1, Math.round((toLocalDate(plan.payday) - toLocalDate(plan.periodStart)) / 86_400_000));
  const elapsed = Math.max(0, totalPeriod - summary.daysToPayday);
  $("#pay-period-progress").style.width = `${Math.min(100, (elapsed / totalPeriod) * 100)}%`;

  renderTimeline(summary);
  renderMove(summary);
}

function renderTimeline(summary) {
  const timeline = $("#timeline");
  const items = [...summary.upcoming].sort((a, b) => toLocalDate(a.due) - toLocalDate(b.due));
  const rows = items.map((bill, index) => `
    <div class="timeline-row" style="--delay:${index * 45}ms">
      <div class="timeline-date"><span>${shortDate.format(toLocalDate(bill.due)).split(",")[0]}</span><strong>${toLocalDate(bill.due).getDate()}</strong></div>
      <div class="timeline-line"><span></span></div>
      <div class="bill-icon">${iconFor(bill.icon || billIcon(bill.category))}</div>
      <div class="bill-info"><strong>${escapeHtml(bill.name)}</strong><span>${escapeHtml(bill.category)}</span></div>
      <strong class="bill-amount">−${money.format(bill.amount)}</strong>
      <button class="remove-bill" data-remove="${bill.id}" aria-label="Remove ${escapeHtml(bill.name)}">×</button>
    </div>`).join("");
  const paydayRow = `
    <div class="timeline-row payday-row" style="--delay:${items.length * 45}ms">
      <div class="timeline-date"><span>${shortDate.format(toLocalDate(plan.payday)).split(",")[0]}</span><strong>${toLocalDate(plan.payday).getDate()}</strong></div>
      <div class="timeline-line"><span></span></div>
      <div class="bill-icon payday">$</div>
      <div class="bill-info"><strong>Payday</strong><span>Your next deposit</span></div>
      <strong class="bill-amount positive">+${money.format(plan.paycheck)}</strong>
    </div>`;
  timeline.innerHTML = rows + paydayRow;
  timeline.querySelectorAll("[data-remove]").forEach((button) => button.addEventListener("click", () => {
    plan.bills = plan.bills.filter((bill) => bill.id !== button.dataset.remove);
    savePlan();
    render();
    showToast("Bill removed from this plan");
  }));
}

function renderMove(summary) {
  const priciest = [...summary.upcoming].sort((a, b) => b.amount - a.amount)[0];
  if (summary.rawRemainder < 0) {
    const gap = Math.abs(summary.rawRemainder);
    $("#move-copy").textContent = `You’re ${money.format(gap)} short of your full buffer. Let’s protect the essentials first.`;
    $("#move-title").textContent = priciest ? `Ask to move ${priciest.name}` : "Lower your buffer for now";
    $("#move-detail").textContent = priciest ? `Moving it past payday creates ${money.format(priciest.amount)} of room.` : "You can rebuild it after payday.";
  } else {
    const daily = money.format(summary.dailySafe);
    $("#move-copy").textContent = `Keeping flexible spending near ${daily} a day gets you there with your buffer intact.`;
    $("#move-title").textContent = priciest ? `Move ${priciest.name} after payday` : "Keep your buffer untouched";
    $("#move-detail").textContent = priciest ? `That would free up ${money.format(priciest.amount)} until payday.` : "A small cushion can prevent the next surprise.";
  }
}

function escapeHtml(value) {
  const node = document.createElement("span");
  node.textContent = value;
  return node.innerHTML;
}

function openDialog(mode) {
  dialogMode = mode;
  const isBill = mode === "bill";
  $("#dialog-title").textContent = isBill ? "Add an upcoming bill" : "Update your plan";
  $("#plan-fields").classList.toggle("hidden", isBill);
  $("#bill-fields").classList.toggle("hidden", !isBill);
  $("#plan-fields").querySelectorAll("input, select").forEach((field) => { field.disabled = isBill; });
  $("#bill-fields").querySelectorAll("input, select").forEach((field) => { field.disabled = !isBill; });
  $("#save-button").textContent = isBill ? "Add bill" : "Save plan";
  if (isBill) {
    $("#bill-date-input").value = dateKey(today);
    $("#bill-name-input").value = "";
    $("#bill-amount-input").value = "";
    setTimeout(() => $("#bill-name-input").focus(), 50);
  } else {
    $("#balance-input").value = plan.balance;
    $("#paycheck-input").value = plan.paycheck;
    $("#payday-input").value = plan.payday;
    $("#buffer-input").value = plan.buffer;
  }
  $("#plan-dialog").showModal();
}

function handleSave(event) {
  event.preventDefault();
  if (dialogMode === "bill") {
    const name = $("#bill-name-input").value.trim();
    const amount = Number($("#bill-amount-input").value);
    const due = $("#bill-date-input").value;
    const category = $("#bill-category-input").value;
    if (!name || !amount || !due) return;
    plan.bills.push({ id: crypto.randomUUID(), name, amount, due, category, icon: billIcon(category) });
    showToast(`${name} added to your timeline`);
  } else {
    plan.balance = Number($("#balance-input").value);
    plan.paycheck = Number($("#paycheck-input").value);
    plan.payday = $("#payday-input").value;
    plan.buffer = Number($("#buffer-input").value);
    showToast("Your plan is up to date");
  }
  savePlan();
  render();
  $("#plan-dialog").close();
}

function coachAnswer(question) {
  const summary = calculatePlan(plan, today);
  const q = question.toLowerCase();
  if (q.includes("takeout") || q.includes("afford")) {
    const dinner = 30;
    return summary.safeToSpend >= dinner
      ? `Yes—${money.format(dinner)} for takeout fits today. You’d still have ${money.format(summary.safeToSpend - dinner)} safe to spend before payday.`
      : `I’d skip it tonight. Your bills and ${money.format(plan.buffer)} buffer already use the room in this pay period.`;
  }
  if (q.includes("late") || q.includes("delay")) {
    const extraDays = 3;
    const daily = summary.safeToSpend / Math.max(1, summary.daysToPayday + extraDays);
    return `If payday slips by ${extraDays} days, aim for about ${money.format(daily)} a day in flexible spending. Your upcoming essentials total ${money.format(summary.billsTotal)}.`;
  }
  if (q.includes("50") || q.includes("save") || q.includes("find")) {
    const priciest = [...summary.upcoming].sort((a, b) => b.amount - a.amount)[0];
    return priciest
      ? `Start with ${priciest.name}. Moving or splitting that ${money.format(priciest.amount)} bill would create the fastest breathing room. Then look for ${money.format(Math.max(0, 50 - priciest.amount))} in flexible spending.`
      : `Set aside ${money.format(50)} now and treat the remaining ${money.format(Math.max(0, summary.safeToSpend - 50))} as your safe-to-spend amount.`;
  }
  return `Based on this plan, you have ${money.format(summary.safeToSpend)} safe to spend across ${summary.daysToPayday} days—about ${money.format(summary.dailySafe)} a day. Ask me about a purchase, a late paycheck, or finding extra room.`;
}

function renderAgentTrace(trace) {
  const details = $("#agent-trace");
  const completed = trace.filter((entry) => entry.phase === "completed");
  if (!completed.length) {
    details.hidden = true;
    return;
  }
  const labels = {
    get_financial_snapshot: "Loaded the current financial snapshot",
    build_cashflow_timeline: "Calculated the baseline cash-flow timeline",
    simulate_disruption: "Simulated the disruption",
    identify_pressure_points: "Identified the highest-pressure points",
    compare_plan_options: "Compared ways to create breathing room",
    verify_financial_plan: "Independently verified the recommendation"
  };
  $("#agent-trace-list").innerHTML = completed.map((entry) => `<li>${escapeHtml(labels[entry.tool] || entry.tool)}${entry.failed ? " (failed)" : ""}</li>`).join("");
  details.hidden = false;
}

async function askCoach(question) {
  if (!question.trim()) return;
  const message = $("#coach-message");
  message.classList.add("thinking");
  message.innerHTML = '<span class="sparkle" aria-hidden="true">✦</span><p>Working that into your plan…</p>';
  $("#agent-trace").hidden = true;
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, message: question, plan })
    });
    if (!response.ok) throw new Error("Agent unavailable");
    const result = await response.json();
    const recommendation = result.recommendation;
    const action = recommendation.recommendedActions?.[0];
    const actionText = action ? ` ${action.title}: ${action.rationale}` : "";
    message.innerHTML = `<span class="sparkle" aria-hidden="true">✦</span><p>${escapeHtml(recommendation.summary + actionText)}</p>`;
    renderAgentTrace(result.trace || []);
    message.classList.remove("thinking");
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 320));
    message.innerHTML = `<span class="sparkle" aria-hidden="true">✦</span><p>${escapeHtml(coachAnswer(question))}</p>`;
    message.classList.remove("thinking");
    $("#agent-status").classList.remove("connected");
    $("#agent-status").lastChild.textContent = " Local preview";
  }
}

async function checkAgentStatus() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) return;
    $("#agent-status").classList.add("connected");
    $("#agent-status").lastChild.textContent = " Strands backend online";
  } catch {
    // The deterministic local coach remains available when the agent server is offline.
  }
}

let toastTimer;
function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2600);
}

$("#settings-button").addEventListener("click", () => openDialog("plan"));
$("#balance-button").addEventListener("click", () => openDialog("plan"));
$("#add-bill-button").addEventListener("click", () => openDialog("bill"));
$("#plan-form").addEventListener("submit", handleSave);
$("#close-dialog-button").addEventListener("click", () => $("#plan-dialog").close());
$("#cancel-dialog-button").addEventListener("click", () => $("#plan-dialog").close());
$("#ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  askCoach($("#ask-input").value);
  $("#ask-input").value = "";
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => askCoach(button.dataset.prompt)));
$("#try-move-button").addEventListener("click", () => askCoach("Help me find $50"));

render();
checkAgentStatus();
