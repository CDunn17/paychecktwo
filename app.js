import { calculatePlan, dateKey, shiftDate, toLocalDate } from "./src/plan.js";

const STORAGE_KEY = "paycheck-two-plan-v1";
const SESSION_KEY = "paycheck-two-session-v1";
const KNOWLEDGE_KEY = "paycheck-two-policy-sources-v1";
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
let policySources = loadPolicySources();
let dialogMode = "plan";
let sessionId = loadSessionId();
let pendingAgentRequest = null;

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
  return `demo-${crypto.randomUUID()}`;
}

function loadPolicySources() {
  try {
    const stored = JSON.parse(localStorage.getItem(KNOWLEDGE_KEY));
    if (Array.isArray(stored)) return stored;
  } catch (error) {
    console.warn("Could not restore saved policy sources", error);
  }
  return [];
}

function savePlan() {
  if (isPrivateMode()) return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
}

function savePolicySources() {
  if (isPrivateMode()) return;
  localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(policySources));
}

function isPrivateMode() {
  return $("#private-mode")?.checked ?? true;
}

function updatePrivacyStatus() {
  const privateMode = isPrivateMode();
  $("#privacy-status").innerHTML = `<span class="privacy-dot"></span>${privateMode ? "Private mode · not saving new changes" : "Saved on this device"}`;
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
  renderPolicySources();
}

function renderPolicySources() {
  const labels = {
    user_reported: "Remembered",
    provider_terms: "Provider terms",
    provider_confirmation: "Confirmed"
  };
  $("#knowledge-count").textContent = policySources.length === 0
    ? "No saved policies"
    : `${policySources.length} saved ${policySources.length === 1 ? "source" : "sources"}`;
  $("#knowledge-list").innerHTML = policySources.map((source) => `
    <li><span>${escapeHtml(source.title)} · ${escapeHtml(labels[source.sourceType] || source.sourceType)}</span><button type="button" data-remove-knowledge="${escapeHtml(source.id)}" aria-label="Remove ${escapeHtml(source.title)}">×</button></li>
  `).join("");
  $("#knowledge-list").querySelectorAll("[data-remove-knowledge]").forEach((button) => button.addEventListener("click", () => {
    policySources = policySources.filter((source) => source.id !== button.dataset.removeKnowledge);
    savePolicySources();
    renderPolicySources();
    showToast("Policy source removed");
  }));
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
  const isKnowledge = mode === "knowledge";
  $("#dialog-title").textContent = isBill ? "Add an upcoming bill" : isKnowledge ? "Add policy knowledge or terms" : "Update your plan";
  $("#plan-fields").classList.toggle("hidden", isBill || isKnowledge);
  $("#bill-fields").classList.toggle("hidden", !isBill);
  $("#knowledge-fields").classList.toggle("hidden", !isKnowledge);
  $("#plan-fields").querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = isBill || isKnowledge; });
  $("#bill-fields").querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = !isBill; });
  $("#knowledge-fields").querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = !isKnowledge; });
  $("#save-button").textContent = isBill ? "Add bill" : isKnowledge ? "Save source" : "Save plan";
  if (isBill) {
    $("#bill-date-input").value = dateKey(today);
    $("#bill-name-input").value = "";
    $("#bill-amount-input").value = "";
    setTimeout(() => $("#bill-name-input").focus(), 50);
  } else if (isKnowledge) {
    $("#knowledge-type-input").value = "user_reported";
    $("#knowledge-provider-input").value = "";
    $("#knowledge-title-input").value = "";
    $("#knowledge-content-input").value = "";
    $("#knowledge-reference-input").value = "";
    setTimeout(() => $("#knowledge-provider-input").focus(), 50);
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
  } else if (dialogMode === "knowledge") {
    const provider = $("#knowledge-provider-input").value.trim();
    const title = $("#knowledge-title-input").value.trim();
    const content = $("#knowledge-content-input").value.trim();
    if (!provider || !title || !content) return;
    policySources.push({
      id: `policy-${crypto.randomUUID()}`,
      provider,
      title,
      content,
      sourceType: $("#knowledge-type-input").value,
      sourceReference: $("#knowledge-reference-input").value.trim() || null,
      effectiveDate: null,
      lastConfirmedDate: null
    });
    savePolicySources();
    showToast(`${title} saved as policy context`);
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
    review_terms_and_policies: "Reviewed saved policy knowledge and terms",
    evaluate_policy_relief: "Calculated the policy's conditional impact",
    verify_financial_plan: "Independently verified the recommendation"
  };
  $("#agent-trace-list").innerHTML = completed.map((entry) => `<li>${escapeHtml(labels[entry.tool] || entry.tool)}${entry.failed ? " (failed)" : ""}</li>`).join("");
  details.hidden = false;
}

function renderPolicyFindings(findings) {
  const details = $("#policy-review");
  if (!findings?.length) {
    details.hidden = true;
    return;
  }
  const labels = {
    user_reported: "User-reported",
    explicit: "Explicitly supported",
    ambiguous: "Ambiguous"
  };
  $("#policy-review-list").innerHTML = findings.map((finding) => `
    <li><strong>${escapeHtml(finding.title)}</strong>: ${escapeHtml(finding.finding)} <em>(${escapeHtml(labels[finding.supportLevel] || finding.supportLevel)}${finding.needsConfirmation ? "; confirm details" : ""})</em></li>
  `).join("");
  details.hidden = false;
}

function showLocalCoach(question) {
  const message = $("#coach-message");
  message.innerHTML = `<span class="sparkle" aria-hidden="true">✦</span><p>${escapeHtml(coachAnswer(question))}</p>`;
  message.classList.remove("thinking");
  $("#agent-status").classList.remove("connected");
  $("#agent-status").lastChild.textContent = " Local preview";
}

const safetyCategoryLabels = {
  aws_access_key: "AWS access key",
  credential: "Credential or secret",
  payment_card: "Payment card number",
  bank_account: "Bank or routing number",
  social_security_number: "Social Security number",
  email: "Email address",
  phone: "Phone number"
};

function renderSafetyPreview(preview) {
  $("#safety-destination").textContent = preview.destination;
  $("#safety-fields-list").innerHTML = preview.fieldsSent.map((field) => `<li>${escapeHtml(field)}</li>`).join("");
  $("#safety-redactions").innerHTML = preview.redactions.length
    ? `<ul>${preview.redactions.map((item) => `<li><strong>${item.count}</strong> ${escapeHtml(safetyCategoryLabels[item.category] || item.category)} ${item.count === 1 ? "value" : "values"} will be masked</li>`).join("")}</ul>`
    : "<p>No high-confidence identifiers detected.</p>";
  $("#model-consent").checked = false;
  $("#send-safely-button").disabled = true;
}

async function askCoach(question) {
  if (!question.trim()) return;
  const request = { sessionId, message: question, plan, policySources };
  try {
    const response = await fetch("/api/safety/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });
    if (!response.ok) throw new Error("Safety preview unavailable");
    renderSafetyPreview(await response.json());
    pendingAgentRequest = request;
    $("#safety-dialog").showModal();
  } catch {
    showLocalCoach(question);
    showToast("Agent offline — no information was sent");
  }
}

async function sendAgentRequest(request) {
  const message = $("#coach-message");
  message.classList.add("thinking");
  message.innerHTML = '<span class="sparkle" aria-hidden="true">✦</span><p>Working that into your plan…</p>';
  $("#agent-trace").hidden = true;
  $("#policy-review").hidden = true;
  try {
    const response = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        privacy: { consentToModel: true, ephemeral: isPrivateMode() }
      })
    });
    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      if (errorBody.code === "UNSAFE_AGENT_OUTPUT") {
        message.innerHTML = '<span class="sparkle" aria-hidden="true">✦</span><p>The model response was blocked because the safety check found sensitive information. No model answer was shown.</p>';
        message.classList.remove("thinking");
        showToast("Sensitive model output blocked");
        return;
      }
      throw new Error("Agent unavailable");
    }
    const result = await response.json();
    const recommendation = result.recommendation;
    const action = recommendation.recommendedActions?.[0];
    const actionText = action ? ` ${action.title}: ${action.rationale}` : "";
    message.innerHTML = `<span class="sparkle" aria-hidden="true">✦</span><p>${escapeHtml(recommendation.summary + actionText)}</p>`;
    renderAgentTrace(result.trace || []);
    renderPolicyFindings(recommendation.policyFindings || []);
    message.classList.remove("thinking");
    const redactionCount = (result.safety?.inputRedactions || []).reduce((total, item) => total + item.count, 0);
    if (redactionCount > 0) showToast(`${redactionCount} sensitive ${redactionCount === 1 ? "value was" : "values were"} masked before Bedrock`);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 320));
    showLocalCoach(request.message);
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
$("#add-knowledge-button").addEventListener("click", () => openDialog("knowledge"));
$("#plan-form").addEventListener("submit", handleSave);
$("#close-dialog-button").addEventListener("click", () => $("#plan-dialog").close());
$("#cancel-dialog-button").addEventListener("click", () => $("#plan-dialog").close());
$("#private-mode").addEventListener("change", () => {
  if (!isPrivateMode()) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plan));
    localStorage.setItem(KNOWLEDGE_KEY, JSON.stringify(policySources));
    localStorage.setItem(SESSION_KEY, sessionId);
    showToast("New changes will be saved on this device");
  } else {
    showToast("Private mode is on; existing saved data remains until deleted");
  }
  updatePrivacyStatus();
});
$("#delete-local-data-button").addEventListener("click", () => {
  if (!window.confirm("Delete the plan, policy sources, and saved session ID from this browser?")) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(KNOWLEDGE_KEY);
  localStorage.removeItem(SESSION_KEY);
  plan = structuredClone(seedPlan);
  policySources = [];
  sessionId = `demo-${crypto.randomUUID()}`;
  render();
  showToast("Local Paycheck Two data deleted");
});
$("#model-consent").addEventListener("change", () => {
  $("#send-safely-button").disabled = !$("#model-consent").checked;
});
$("#safety-consent-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pendingAgentRequest || !$("#model-consent").checked) return;
  const request = pendingAgentRequest;
  pendingAgentRequest = null;
  $("#safety-dialog").close();
  sendAgentRequest(request);
});
const cancelSafetyDialog = () => {
  pendingAgentRequest = null;
  $("#safety-dialog").close();
};
$("#close-safety-dialog-button").addEventListener("click", cancelSafetyDialog);
$("#cancel-safety-dialog-button").addEventListener("click", cancelSafetyDialog);
$("#ask-form").addEventListener("submit", (event) => {
  event.preventDefault();
  askCoach($("#ask-input").value);
  $("#ask-input").value = "";
});
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => askCoach(button.dataset.prompt)));
$("#try-move-button").addEventListener("click", () => askCoach("Help me find $50"));

render();
updatePrivacyStatus();
checkAgentStatus();
