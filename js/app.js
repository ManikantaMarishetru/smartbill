import { toPaise, toQty, formatINR } from "./money.js";
import { calcBill, paymentStatus, validatePayment } from "./calc.js";
import { summarize, validateCollection, validateCustomer } from "./ledger.js";
import { load, save, nextInvoiceNo, customerOutstanding, uid, KEY, defaultState } from "./store.js";
import { buildInvoicePdfBytes, downloadPdf } from "./pdf.js";
import { invoiceMessage, invoiceBillText, reminderMessage, waLink, pageUrlIfShareable } from "./whatsapp.js";

/* ---------- helpers ---------- */
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function toast(msg, kind = "ok") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = "toast show " + (kind === "err" ? "err" : "ok");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = "toast"; el.textContent = ""; }, 3500);
}
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso || "");
    return d.toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return String(iso || ""); }
}
function fmtDay(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso || "");
    return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  } catch { return String(iso || ""); }
}
function badge(status) {
  const map = { paid: ["b-paid", "Paid"], partially_paid: ["b-partial", "Partial"], unpaid: ["b-unpaid", "Unpaid"], cancelled: ["b-cancelled", "Cancelled"] };
  const m = map[status] || ["b-unpaid", String(status)];
  return `<span class="badge ${m[0]}">${esc(m[1])}</span>`;
}
function safeDecodeParam(s) {
  // A hand-typed/copied hash with a bad % escape makes decodeURIComponent throw;
  // fall back to the raw string so the router shows "not found" instead of crashing.
  try { return decodeURIComponent(s); } catch { return s; }
}
function safeINR(v) {
  // Corrupt stored rows (missing totals/amounts) render as "—" instead of
  // throwing inside formatINR and blanking the whole view.
  return Number.isInteger(v) ? formatINR(v) : "—";
}
function persist(s) {
  // save() throws a friendly Error on quota/storage failure; surface it as a
  // toast and let the caller abort instead of crashing with unsaved state.
  try { save(s || state); return true; }
  catch (e) { toast("Could not save (" + (e && e.message ? e.message : "storage error") + "). Free device storage and retry.", "err"); return false; }
}
let printToken = 0;
function parseSignedPaise(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") throw new Error("Amount is required.");
  if (raw.startsWith("-")) {
    const rest = raw.slice(1).trim();
    if (rest === "") throw new Error("Amount is required.");
    const p = toPaise(rest);
    if (p === 0) throw new Error("Adjustment amount cannot be zero.");
    return -p;
  }
  const p = toPaise(raw);
  if (p === 0) throw new Error("Adjustment amount cannot be zero.");
  return p;
}
function parseTaxRate(input) {
  const raw = String(input ?? "").trim();
  if (raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 28) throw new Error(`Invalid tax "${input}". Use 0 to 28 (%).`);
  return n;
}
function customerById(id) {
  return state.customers.find((c) => c.id === id) || null;
}
function invoiceById(id) {
  return state.invoices.find((i) => i.id === id) || null;
}

/* ---------- state ---------- */
let state = load();
let invoiceSearch = "";
let ledgerFilter = "";
let customerListSearch = "";

function freshDraft() {
  const b = state.business || {};
  return {
    items: [],
    billDiscount: { type: "none", value: 0 },
    billDiscountApplied: false,
    billDiscType: "percent",
    billDiscValue: "",
    manual: { name: "", qty: "1", price: "", tax: "", discType: "none", discValue: "" },
    manualError: "",
    billDiscError: "",
    completeError: "",
    taxMode: b.taxMode || "non-gst",
    gstType: b.gstType || "intrastate",
    priceIncludesTax: !!b.priceIncludesTax,
    customerId: "",
    walkinName: "",
    walkinPhone: "",
    payMethod: "cash",
    paid: "",
  };
}
let draft = freshDraft();
let payKey = uid("pay");

/* ---------- router ---------- */
function route() {
  const h = window.location.hash || "#/dashboard";
  if (h.startsWith("#/invoice/")) return { name: "invoice-detail", param: safeDecodeParam(h.slice("#/invoice/".length)) };
  if (h.startsWith("#/customer/")) return { name: "customer-detail", param: safeDecodeParam(h.slice("#/customer/".length)) };
  if (h === "#/newbill") return { name: "newbill" };
  if (h === "#/invoices") return { name: "invoices" };
  if (h === "#/customers") return { name: "customers" };
  if (h === "#/ledger") return { name: "ledger" };
  if (h === "#/settings") return { name: "settings" };
  return { name: "dashboard" };
}
const sectionFor = {
  dashboard: "view-dashboard",
  newbill: "view-newbill",
  invoices: "view-invoices",
  "invoice-detail": "view-invoice-detail",
  customers: "view-customers",
  "customer-detail": "view-customer-detail",
  ledger: "view-ledger",
  settings: "view-settings",
};
function router() {
  const r = route();
  document.querySelectorAll("main section").forEach((s) => s.classList.remove("active"));
  const sec = document.getElementById(sectionFor[r.name] || "view-dashboard");
  if (sec) sec.classList.add("active");
  const navKey = r.name === "invoice-detail" ? "invoices" : r.name === "customer-detail" ? "customers" : r.name;
  document.querySelectorAll("button[data-view]").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-view") === navKey);
  });
  if (r.name === "dashboard") renderDashboard();
  else if (r.name === "newbill") renderBill();
  else if (r.name === "invoices") renderInvoices();
  else if (r.name === "invoice-detail") renderInvoiceDetail(r.param);
  else if (r.name === "customers") renderCustomers();
  else if (r.name === "customer-detail") renderCustomerDetail(r.param);
  else if (r.name === "ledger") renderLedger();
  else if (r.name === "settings") renderSettings();
}
function refresh() {
  router();
}

/* ---------- dashboard ---------- */
function renderDashboard() {
  const el = document.getElementById("dashboard-app");
  if (!el) return;
  const today = new Date().toISOString().slice(0, 10);
  const valid = state.invoices.filter((i) => i && i.status !== "cancelled");
  const todayInvs = valid.filter((i) => String(i.date || "").slice(0, 10) === today);
  const todayTotal = todayInvs.reduce((s, i) => s + (i.totals && Number.isInteger(i.totals.grandTotal) ? i.totals.grandTotal : 0), 0);
  let outstanding = 0;
  for (const c of state.customers) outstanding += customerOutstanding(state, c.id);
  const recent = [...valid].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  let html = `<h2>Dashboard</h2>`;
  html += `<div class="grid">`;
  html += `<div class="card"><div><strong>Today's sales</strong></div><div style="font-size:22px;font-weight:700">${formatINR(todayTotal)}</div><div>${todayInvs.length} invoice(s) today</div></div>`;
  html += `<div class="card"><div><strong>Invoices</strong></div><div style="font-size:22px;font-weight:700">${valid.length}</div><div>Total bills (excluding cancelled)</div></div>`;
  html += `<div class="card"><div><strong>Total outstanding</strong></div><div style="font-size:22px;font-weight:700">${formatINR(outstanding)}</div><div>Across ${state.customers.length} customer(s)</div></div>`;
  html += `<div class="card"><div><strong>About your data</strong></div><div>Data is stored only on this device (localStorage), not in the cloud. Clearing browser data deletes it.</div></div>`;
  html += `</div>`;
  if (valid.length === 0 && state.customers.length === 0) {
    html += `<div class="empty">No sales yet — create your first bill from New Bill.</div>`;
  } else if (recent.length > 0) {
    html += `<div class="card"><strong>Recent invoices</strong><div class="table-wrap"><table class="table"><thead><tr><th>Number</th><th>Date</th><th>Total</th><th>Status</th></tr></thead><tbody>`;
    for (const inv of recent) {
      html += `<tr><td><a href="#/invoice/${esc(inv.id)}">${esc(inv.number)}</a></td><td>${esc(fmtDay(inv.date))}</td><td>${safeINR(inv.totals ? inv.totals.grandTotal : undefined)}</td><td>${badge(inv.status)}</td></tr>`;
    }
    html += `</tbody></table></div></div>`;
  }
  el.innerHTML = html;
}

/* ---------- new bill ---------- */
function draftTax() {
  // Coerce to known enum values so a tampered DOM select cannot smuggle an
  // unknown mode/gstType into the bill math or stored invoice.
  const mode = draft.taxMode === "gst" ? "gst" : "non-gst";
  const gstType = draft.gstType === "interstate" ? "interstate" : "intrastate";
  return { mode, gstType, priceIncludesTax: !!draft.priceIncludesTax };
}
function draftCalc() {
  try {
    return calcBill(draft.items, draft.billDiscount, draftTax());
  } catch {
    return null;
  }
}
function draftPaidPaise() {
  const raw = String(draft.paid ?? "").trim();
  if (raw === "") return { paise: 0, error: null };
  try {
    return { paise: toPaise(raw), error: null };
  } catch (e) {
    return { paise: 0, error: e.message };
  }
}
function renderBill() {
  const el = document.getElementById("bill-app");
  if (!el) return;
  const calc = draftCalc();
  const paidInfo = draftPaidPaise();

  let html = `<h2>New Bill</h2>`;
  if (draft.completeError) html += `<div class="error">${esc(draft.completeError)}</div>`;

  // manual form
  const m = draft.manual;
  html += `<div class="card"><strong>1. Add item manually</strong>
    ${m && draft.manualError ? `<div class="error">${esc(draft.manualError)}</div>` : ""}
    <div class="field"><label>Item name *</label><input id="m-name" class="input" value="${esc(m.name)}" placeholder="e.g. Wheat Flour 5kg"></div>

    <div class="row-flex">
      <div class="field" style="flex:1"><label>Qty *</label><input id="m-qty" class="input" value="${esc(m.qty)}" inputmode="numeric"></div>
      <div class="field" style="flex:1"><label>Price (₹) *</label><input id="m-price" class="input" value="${esc(m.price)}" placeholder="e.g. 250 or 250.50" inputmode="decimal"></div>
      <div class="field" style="flex:1"><label>Tax %</label><input id="m-tax" class="input" value="${esc(m.tax)}" placeholder="0–28"></div>
    </div>
    <div class="row-flex">
      <div class="field" style="flex:1"><label>Discount type</label><select id="m-disctype" class="input">
        <option value="none"${m.discType === "none" ? " selected" : ""}>None</option>
        <option value="percent"${m.discType === "percent" ? " selected" : ""}>Percent %</option>
        <option value="fixed"${m.discType === "fixed" ? " selected" : ""}>Fixed ₹</option>
      </select></div>
      <div class="field" style="flex:1"><label>Discount value</label><input id="m-discval" class="input" value="${esc(m.discValue)}" placeholder="% or ₹"></div>
    </div>
    <button class="btn btn-primary" id="m-add">Add item</button></div>`;

  // draft rows
  html += `<div class="card"><strong>2. Bill items (${draft.items.length})</strong><div id="bill-rows">`;
  if (draft.items.length === 0) {
    html += `<div class="empty">No items yet. Add items manually below.</div>`;
  } else {
    html += `<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th></th></tr></thead><tbody>`;
    draft.items.forEach((it, idx) => {
      html += `<tr><td>${esc(it.name)}<br><small>${esc(String(it.taxRate))}% · ${esc(it.discountType)}${it.discountType !== "none" ? " " + esc(String(it.discountValue)) : ""}</small></td>
        <td><div class="row-flex"><button class="btn" data-qminus="${idx}">−</button><span>${it.qty}</span><button class="btn" data-qplus="${idx}">+</button></div></td>
        <td>${formatINR(it.unitPricePaise)}</td>
        <td><button class="btn btn-danger" data-rm="${idx}">Remove</button></td></tr>`;
    });
    html += `</tbody></table></div>`;
  }
  html += `</div></div>`;

  // bill discount (applied once)
  html += `<div class="card"><strong>3. Bill discount (applied once)</strong>`;
  if (draft.billDiscountApplied) {
    const bd = draft.billDiscount;
    const label = bd.type === "percent" ? `${esc(String(bd.value))}%` : bd.type === "fixed" ? formatINR(bd.value) : "none";
    html += `<div>Applied: ${esc(bd.type)} ${label}</div><div><button class="btn" id="bd-clear">Applied — Clear to change</button></div>`;
  } else {
    if (draft.billDiscError) html += `<div class="error">${esc(draft.billDiscError)}</div>`;
    html += `<div class="row-flex"><div class="field" style="flex:1"><label>Type</label><select id="bd-type" class="input">
      <option value="none"${draft.billDiscType === "none" ? " selected" : ""}>None</option>
      <option value="percent"${draft.billDiscType === "percent" ? " selected" : ""}>Percent %</option>
      <option value="fixed"${draft.billDiscType === "fixed" ? " selected" : ""}>Fixed ₹</option></select></div>
      <div class="field" style="flex:1"><label>Value</label><input id="bd-value" class="input" value="${esc(draft.billDiscValue)}" placeholder="% or ₹"></div></div>
      <button class="btn" id="bd-apply">Apply discount</button>`;
  }
  html += `</div>`;

  // tax config
  html += `<div class="card"><strong>4. Tax</strong><div class="row-flex">
    <div class="field" style="flex:1"><label>Tax mode</label><select id="tax-mode" class="input">
      <option value="non-gst"${draft.taxMode === "non-gst" ? " selected" : ""}>Non-GST</option>
      <option value="gst"${draft.taxMode === "gst" ? " selected" : ""}>GST</option></select></div>
    <div class="field" style="flex:1"><label>GST type</label><select id="tax-gsttype" class="input">
      <option value="intrastate"${draft.gstType === "intrastate" ? " selected" : ""}>Intrastate (CGST+SGST)</option>
      <option value="interstate"${draft.gstType === "interstate" ? " selected" : ""}>Interstate (IGST)</option></select></div>
    <div class="field" style="flex:1"><label>Price includes tax?</label><select id="tax-incl" class="input">
      <option value="no"${!draft.priceIncludesTax ? " selected" : ""}>Exclusive — add tax on top</option>
      <option value="yes"${draft.priceIncludesTax ? " selected" : ""}>Inclusive — price includes tax</option></select></div>
    </div><small>Defaults come from Settings. GST is never applied twice — inclusive prices extract tax instead of adding it.</small></div>`;

  // customer
  html += `<div class="card"><strong>5. Customer</strong>
    <div class="field"><label>Existing customer (optional — needed for credit/ledger)</label><select id="bill-customer" class="input"><option value="">Walk-in (no ledger)</option>`;
  for (const c of state.customers) {
    html += `<option value="${esc(c.id)}"${draft.customerId === c.id ? " selected" : ""}>${esc(c.name)}${c.phone ? " (" + esc(c.phone) + ")" : ""}</option>`;
  }
  html += `</select></div>
    <div class="row-flex"><div class="field" style="flex:1"><label>Walk-in name</label><input id="bill-walkname" class="input" value="${esc(draft.walkinName)}" placeholder="Walk-in"></div>
    <div class="field" style="flex:1"><label>Walk-in phone</label><input id="bill-walkphone" class="input" value="${esc(draft.walkinPhone)}"></div></div>
    <small>Choose an existing customer to track dues, or leave as walk-in.</small></div>`;

  // payment
  html += `<div class="card"><strong>6. Payment</strong><div class="row-flex">
    <div class="field" style="flex:1"><label>Method</label><select id="bill-paymethod" class="input">
      <option value="cash"${draft.payMethod === "cash" ? " selected" : ""}>Cash</option>
      <option value="upi"${draft.payMethod === "upi" ? " selected" : ""}>UPI</option>
      <option value="card"${draft.payMethod === "card" ? " selected" : ""}>Card</option>
      <option value="credit"${draft.payMethod === "credit" ? " selected" : ""}>Credit (due later)</option></select></div>
    <div class="field" style="flex:1"><label>Amount paid (₹)</label><input id="bill-paid" class="input" value="${esc(draft.paid)}" placeholder="e.g. 500 (empty = 0)" inputmode="decimal"></div></div>
    ${paidInfo.error ? `<div class="error">${esc(paidInfo.error)}</div>` : ""}</div>`;

  // totals
  html += `<div class="totals" id="bill-totals">` + billTotalsHtml(calc, paidInfo) + `</div>`;
  html += `<div class="row-flex" style="margin-top:10px"><button class="btn btn-primary" id="bill-complete">Complete Sale</button><button class="btn" id="bill-clear">Clear</button></div>`;
  el.innerHTML = html;
  wireBill(el);
}
function billTotalsHtml(calc, paidInfo) {
  if (!calc) return `<div class="error">Could not compute totals.</div>`;
  const paid = paidInfo && !paidInfo.error ? paidInfo.paise : 0;
  const due = calc.grandTotal - paid;
  let taxLines = "";
  if (draft.taxMode === "gst") {
    if (draft.gstType === "interstate") taxLines = `<div>IGST: ${formatINR(calc.igstTotal)}</div>`;
    else taxLines = `<div>CGST: ${formatINR(calc.cgstTotal)}</div><div>SGST: ${formatINR(calc.sgstTotal)}</div>`;
  } else {
    taxLines = `<div>Tax (non-GST): ${formatINR(calc.taxTotal)}</div>`;
  }
  let errHtml = "";
  if (calc.errors && calc.errors.length) errHtml = `<div class="error">${calc.errors.map(esc).join("<br>")}</div>`;
  const payErr = validatePayment(calc.grandTotal, paid);
  const payErrHtml = payErr ? `<div class="error">${esc(payErr)}</div>` : "";
  return `${errHtml}${payErrHtml}
    <div>Subtotal: ${formatINR(calc.subtotalGross)}</div>
    <div>Item discounts: −${formatINR(calc.itemDiscountTotal)}</div>
    <div>Bill discount: −${formatINR(calc.billDiscountPaise)}</div>
    <div>Taxable value: ${formatINR(calc.taxableValue)}</div>
    ${taxLines}
    <div>Rounding: ${formatINR(calc.roundoff)}</div>
    <div class="grand">Grand total: ${formatINR(calc.grandTotal)}</div>
    <div>Paid: ${formatINR(paid)}</div>
    <div>Due: ${formatINR(due)}</div>`;
}
function refreshBillTotals() {
  const box = document.getElementById("bill-totals");
  if (!box) return;
  box.innerHTML = billTotalsHtml(draftCalc(), draftPaidPaise());
}
function syncDraftInputs(root) {
  const g = (id) => { const e = root.querySelector("#" + id); return e ? e.value : null; };
  const v = (id) => g(id);
  if (v("m-name") !== null) draft.manual.name = v("m-name");
  
  if (v("m-qty") !== null) draft.manual.qty = v("m-qty");
  if (v("m-price") !== null) draft.manual.price = v("m-price");
  if (v("m-tax") !== null) draft.manual.tax = v("m-tax");
  if (v("m-disctype") !== null) draft.manual.discType = v("m-disctype");
  if (v("m-discval") !== null) draft.manual.discValue = v("m-discval");
  if (v("bd-type") !== null) draft.billDiscType = v("bd-type");
  if (v("bd-value") !== null) draft.billDiscValue = v("bd-value");
  if (v("tax-mode") !== null) draft.taxMode = v("tax-mode");
  if (v("tax-gsttype") !== null) draft.gstType = v("tax-gsttype");
  if (v("tax-incl") !== null) draft.priceIncludesTax = v("tax-incl") === "yes";
  if (v("bill-customer") !== null) draft.customerId = v("bill-customer");
  if (v("bill-walkname") !== null) draft.walkinName = v("bill-walkname");
  if (v("bill-walkphone") !== null) draft.walkinPhone = v("bill-walkphone");
  if (v("bill-paymethod") !== null) draft.payMethod = v("bill-paymethod");
  if (v("bill-paid") !== null) draft.paid = v("bill-paid");
}
function wireBill(root) {
  const madd = root.querySelector("#m-add");
  if (madd) madd.addEventListener("click", () => { syncDraftInputs(root); addManualItem(); });
  root.querySelectorAll("[data-qminus]").forEach((b) => b.addEventListener("click", () => {
    syncDraftInputs(root);
    const i = Number(b.getAttribute("data-qminus"));
    if (draft.items[i]) { draft.items[i].qty -= 1; if (draft.items[i].qty < 1) draft.items.splice(i, 1); }
    draft.completeError = ""; renderBill();
  }));
  root.querySelectorAll("[data-qplus]").forEach((b) => b.addEventListener("click", () => {
    syncDraftInputs(root);
    const i = Number(b.getAttribute("data-qplus"));
    if (draft.items[i]) { draft.items[i].qty += 1; if (draft.items[i].qty > 100000) draft.items[i].qty = 100000; }
    draft.completeError = ""; renderBill();
  }));
  root.querySelectorAll("[data-rm]").forEach((b) => b.addEventListener("click", () => {
    syncDraftInputs(root);
    draft.items.splice(Number(b.getAttribute("data-rm")), 1);
    draft.completeError = ""; renderBill();
  }));
  const apply = root.querySelector("#bd-apply");
  if (apply) apply.addEventListener("click", () => { syncDraftInputs(root); applyBillDiscount(); });
  const bdclear = root.querySelector("#bd-clear");
  if (bdclear) bdclear.addEventListener("click", () => {
    syncDraftInputs(root);
    draft.billDiscount = { type: "none", value: 0 };
    draft.billDiscountApplied = false;
    draft.billDiscType = "percent"; draft.billDiscValue = ""; draft.billDiscError = "";
    renderBill();
  });
  ["#tax-mode", "#tax-gsttype", "#tax-incl", "#bill-customer", "#bill-paymethod"].forEach((sel) => {
    const e = root.querySelector(sel);
    if (e) e.addEventListener("change", () => { syncDraftInputs(root); draft.completeError = ""; refreshBillTotals(); });
  });
  ["#bill-walkname", "#bill-walkphone", "#bill-paid", "#bd-value", "#m-name", "#m-qty", "#m-price", "#m-tax", "#m-discval"].forEach((sel) => {
    const e = root.querySelector(sel);
    if (e) e.addEventListener("input", () => { syncDraftInputs(root); refreshBillTotals(); });
  });
  ["#m-disctype", "#bd-type"].forEach((sel) => {
    const e = root.querySelector(sel);
    if (e) e.addEventListener("change", () => { syncDraftInputs(root); refreshBillTotals(); });
  });
  const comp = root.querySelector("#bill-complete");
  if (comp) comp.addEventListener("click", () => { syncDraftInputs(root); completeSale(); });
  const clr = root.querySelector("#bill-clear");
  if (clr) clr.addEventListener("click", () => {
    syncDraftInputs(root);
    if (!window.confirm("Clear this bill draft?")) return;
    draft = freshDraft();
    renderBill();
  });
}
function addManualItem() {
  draft.manualError = "";
  try {
    const m = draft.manual;
    const name = String(m.name || "").trim();
    if (!name) throw new Error("Item name is required.");
    const qty = toQty(m.qty);
    const price = toPaise(m.price);
    const tax = parseTaxRate(m.tax);
    let discType = m.discType || "none";
    let discValue = 0;
    if (discType === "percent") {
      const raw = String(m.discValue || "").trim();
      discValue = raw === "" ? 0 : Number(raw);
      if (!Number.isFinite(discValue) || discValue < 0 || discValue > 100) throw new Error("Item discount % must be between 0 and 100.");
    } else if (discType === "fixed") {
      const raw = String(m.discValue || "").trim();
      discValue = raw === "" ? 0 : toPaise(raw);
    } else { discType = "none"; discValue = 0; }
    draft.items.push({ name, qty, unitPricePaise: price, taxRate: tax, discountType: discType, discountValue: discValue });
    draft.manual = { name: "", qty: "1", price: "", tax: "", discType: "none", discValue: "" };
    draft.completeError = "";
    renderBill();
  } catch (e) {
    draft.manualError = e.message;
    renderBill();
  }
}
function applyBillDiscount() {
  draft.billDiscError = "";
  try {
    const t = draft.billDiscType || "none";
    const raw = String(draft.billDiscValue || "").trim();
    if (t === "none") {
      draft.billDiscount = { type: "none", value: 0 };
      draft.billDiscountApplied = false;
      renderBill();
      return;
    }
    if (t === "percent") {
      if (raw === "") throw new Error("Enter a discount % (more than 0, at most 100).");
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0 || n > 100) throw new Error("Bill discount % must be more than 0 and at most 100.");
      draft.billDiscount = { type: "percent", value: n };
    } else if (t === "fixed") {
      if (raw === "") throw new Error("Enter a discount amount (more than zero).");
      const p = toPaise(raw);
      if (p <= 0) throw new Error("Bill discount amount must be more than zero.");
      draft.billDiscount = { type: "fixed", value: p };
    } else {
      // Defensive: an unknown select value must not mark a stale discount applied.
      draft.billDiscount = { type: "none", value: 0 };
    }
    draft.billDiscountApplied = true;
    draft.completeError = "";
    renderBill();
  } catch (e) {
    draft.billDiscError = e.message;
    renderBill();
  }
}
function completeSale() {
  draft.completeError = "";
  // Re-read storage so invoice numbers and customer data are never based on a
  // stale in-memory copy (e.g. another tab added a sale meanwhile).
  state = load();
  const tax = draftTax();
  const calc = calcBill(draft.items, draft.billDiscount, tax);
  if (calc.errors.length > 0) {
    draft.completeError = calc.errors.join(" ");
    renderBill();
    return;
  }
  let paidPaise = 0;
  const rawPaid = String(draft.paid ?? "").trim();
  try {
    paidPaise = rawPaid === "" ? 0 : toPaise(rawPaid);
  } catch (e) {
    draft.completeError = e.message;
    renderBill();
    return;
  }
  const payErr = validatePayment(calc.grandTotal, paidPaise);
  if (payErr) {
    draft.completeError = payErr;
    renderBill();
    return;
  }
  let customerId = null, customerName = "Walk-in", customerPhone = "";
  if (draft.customerId) {
    const c = customerById(draft.customerId);
    if (!c) {
      draft.completeError = "Selected customer no longer exists. Choose another or use walk-in.";
      renderBill();
      return;
    }
    customerId = c.id; customerName = c.name; customerPhone = c.phone || "";
  } else {
    customerName = String(draft.walkinName || "").trim() || "Walk-in";
    customerPhone = String(draft.walkinPhone || "").trim();
  }
  const number = nextInvoiceNo(state);
  const now = new Date().toISOString();
  const itemsSnapshot = calc.lines.map((l) => ({
    name: l.name, qty: l.qty, unitPricePaise: l.unitPricePaise, taxRate: l.taxRate,
    discountType: l.discountType || "none", discountValue: l.discountValue || 0,
    gross: l.gross, itemDiscount: l.itemDiscount, billDiscountShare: l.billDiscountShare || 0,
    taxable: l.taxable, tax: l.tax, cgst: l.cgst || 0, sgst: l.sgst || 0, igst: l.igst || 0, lineTotal: l.lineTotal,
  }));
  const totals = {
    subtotalGross: calc.subtotalGross, itemDiscountTotal: calc.itemDiscountTotal, billDiscountPaise: calc.billDiscountPaise,
    taxableValue: calc.taxableValue, taxTotal: calc.taxTotal, cgstTotal: calc.cgstTotal, sgstTotal: calc.sgstTotal,
    igstTotal: calc.igstTotal, beforeRounding: calc.beforeRounding, roundoff: calc.roundoff, grandTotal: calc.grandTotal,
  };
  const status = paymentStatus(calc.grandTotal, paidPaise);
  const balance = calc.grandTotal - paidPaise;
  const inv = {
    id: uid("inv"), number, date: now, mode: tax.mode, gstType: tax.gstType, priceIncludesTax: !!tax.priceIncludesTax,
    billDiscount: { ...draft.billDiscount }, customerId, customerName, customerPhone,
    itemsSnapshot, totals, paymentMethod: draft.payMethod, paidPaise, balancePaise: balance, status,
    businessName: (state.business && state.business.name) || "My Shop", createdAt: now,
  };
  state.invoices.push(inv);
  if (customerId && (draft.payMethod === "credit" || balance > 0)) {
    state.ledger.push({ id: uid("txn"), customerId, type: "credit_sale", amountPaise: calc.grandTotal, invoiceId: inv.id, createdAt: now, createdBy: "local-user" });
    if (paidPaise > 0) {
      state.ledger.push({ id: uid("txn"), customerId, type: "payment", amountPaise: -paidPaise, invoiceId: inv.id, note: `Paid with bill (${draft.payMethod})`, createdAt: now, createdBy: "local-user" });
    }
  }
  if (!persist()) {
    draft.completeError = "Could not save this sale (device storage issue). Free space and retry — the bill draft is kept.";
    renderBill();
    return;
  }
  draft = freshDraft();
  toast(`Sale ${number} completed.`);
  window.location.hash = "#/invoice/" + encodeURIComponent(inv.id);
}

/* ---------- invoices ---------- */
function renderInvoices() {
  const el = document.getElementById("invoices-app");
  if (!el) return;
  let html = `<h2>Invoices</h2>
    <div class="card"><div class="field"><label>Search by number or customer</label><input id="inv-search" class="input" value="${esc(invoiceSearch)}" placeholder="e.g. SB-2026 or Walk-in"></div></div>
    <div id="inv-table"></div>`;
  el.innerHTML = html;
  const input = el.querySelector("#inv-search");
  const draw = () => {
    const q = invoiceSearch.trim().toLowerCase();
    const list = [...state.invoices].sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .filter((i) => !q || (i.number + " " + (i.customerName || "")).toLowerCase().includes(q));
    const box = el.querySelector("#inv-table");
    if (list.length === 0) {
      box.innerHTML = `<div class="empty">No invoices found. ${state.invoices.length === 0 ? "Create your first bill from New Bill." : "Try a different search."}</div>`;
      return;
    }
    let t = `<div class="table-wrap"><table class="table"><thead><tr><th>Number</th><th>Date</th><th>Customer</th><th>Total</th><th>Paid</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>`;
    for (const inv of list) {
      t += `<tr><td>${esc(inv.number)}</td><td>${esc(fmtDay(inv.date))}</td><td>${esc(inv.customerName || "Walk-in")}</td>
        <td>${safeINR(inv.totals ? inv.totals.grandTotal : undefined)}</td><td>${safeINR(inv.paidPaise)}</td><td>${safeINR(inv.balancePaise)}</td>
        <td>${badge(inv.status)}</td><td><a href="#/invoice/${esc(inv.id)}">View</a></td></tr>`;
    }
    t += `</tbody></table></div>`;
    box.innerHTML = t;
  };
  if (input) input.addEventListener("input", () => { invoiceSearch = input.value; draw(); });
  draw();
}
function invoiceTotalsTable(inv) {
  const t = (inv.totals && typeof inv.totals === "object") ? inv.totals : {};
  let taxRows = "";
  if (inv.mode === "gst") {
    if (inv.gstType === "interstate") taxRows = `<tr><td>IGST</td><td>${safeINR(t.igstTotal)}</td></tr>`;
    else taxRows = `<tr><td>CGST</td><td>${safeINR(t.cgstTotal)}</td></tr><tr><td>SGST</td><td>${safeINR(t.sgstTotal)}</td></tr>`;
  } else {
    taxRows = `<tr><td>Tax (non-GST)</td><td>${safeINR(t.taxTotal)}</td></tr>`;
  }
  return `<div class="table-wrap"><table class="table"><tbody>
    <tr><td>Subtotal</td><td>${safeINR(t.subtotalGross)}</td></tr>
    <tr><td>Item discounts</td><td>−${safeINR(t.itemDiscountTotal)}</td></tr>
    <tr><td>Bill discount</td><td>−${safeINR(t.billDiscountPaise)}</td></tr>
    <tr><td>Taxable value</td><td>${safeINR(t.taxableValue)}</td></tr>
    ${taxRows}
    <tr><td>Rounding</td><td>${safeINR(t.roundoff)}</td></tr>
    <tr><td><strong>Grand total</strong></td><td><strong>${safeINR(t.grandTotal)}</strong></td></tr>
    <tr><td>Paid (${esc(inv.paymentMethod)})</td><td>${safeINR(inv.paidPaise)}</td></tr>
    <tr><td>Due</td><td>${safeINR(inv.balancePaise)}</td></tr>
    <tr><td>Status</td><td>${badge(inv.status)}</td></tr>
  </tbody></table></div>`;
}
function renderInvoiceDetail(id) {
  const el = document.getElementById("invoice-detail-app");
  if (!el) return;
  const inv = invoiceById(id);
  if (!inv) {
    el.innerHTML = `<h2>Invoice</h2><div class="error">Invoice not found. It may have been cleared with browser data.</div><p><a href="#/invoices">Back to invoices</a></p>`;
    return;
  }
  const b = state.business || {};
  let items = `<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Disc</th><th>Tax</th><th>Total</th></tr></thead><tbody>`;
  const snap = Array.isArray(inv.itemsSnapshot) ? inv.itemsSnapshot : [];
  for (const it of snap) {
    if (!it || typeof it !== "object") continue;
    items += `<tr><td>${esc(it.name)}</td><td>${it.qty}</td><td>${safeINR(it.unitPricePaise)}</td><td>${safeINR((it.itemDiscount || 0) + (it.billDiscountShare || 0))}</td><td>${safeINR(it.tax)} <small>(${esc(String(it.taxRate))}%)</small></td><td>${safeINR((it.taxable || 0) + (it.tax || 0))}</td></tr>`;
  }
  items += `</tbody></table></div>`;
  let html = `<p><a href="#/invoices">← Back to invoices</a></p><h2>Invoice ${esc(inv.number)}</h2>`;
  html += `<div class="card"><strong>${esc(b.name || inv.businessName || "SmartBill")}</strong><br><small>${esc(b.address || "")}${b.phone ? " · " + esc(b.phone) : ""}${b.gstin ? " · GSTIN: " + esc(b.gstin) : ""}</small>
    <div>Date: ${esc(fmtDate(inv.date))} · ${esc(inv.mode === "gst" ? "GST " : "")}${esc(inv.gstType)} · ${inv.priceIncludesTax ? "prices include tax" : "prices exclude tax"}</div>
    <div>Customer: ${esc(inv.customerName || "Walk-in")}${inv.customerPhone ? " (" + esc(inv.customerPhone) + ")" : ""}</div></div>`;
  html += `<div class="card">${items}</div>`;
  html += `<div class="card">${invoiceTotalsTable(inv)}</div>`;
  html += `<div class="card"><div class="row-flex">
    <button class="btn" id="inv-pdf">Download PDF</button>
    <button class="btn" id="inv-print58">Print 58mm</button>
    <button class="btn" id="inv-print80">Print 80mm</button>
    <button class="btn btn-primary" id="inv-wa">Send Bill on WhatsApp</button>
    <button class="btn" id="inv-sharepdf">Share PDF</button>
    ${inv.status !== "cancelled" ? `<button class="btn btn-danger" id="inv-cancel">Cancel Invoice</button>` : ""}
    </div>
    <div style="margin-top:8px"><small>Sends the FULL itemised bill as a WhatsApp message — you still press Send in WhatsApp. To send the PDF file itself, use Share PDF (choose WhatsApp in the share sheet).</small></div>
    <div id="inv-msg"></div></div>`;
  el.innerHTML = html;
  el.querySelector("#inv-pdf").addEventListener("click", () => {
    try {
      const bytes = buildInvoicePdfBytes(inv, state.business || {});
      downloadPdf(`${inv.number}.pdf`, bytes);
      toast("PDF downloaded.");
    } catch (e) { toast("PDF failed: " + e.message, "err"); }
  });
  el.querySelector("#inv-print58").addEventListener("click", () => printInvoice(inv, "print-58"));
  el.querySelector("#inv-print80").addEventListener("click", () => printInvoice(inv, "print-80"));
  el.querySelector("#inv-wa").addEventListener("click", () => {
    const msg = invoiceBillText(inv, state.business || {});
    const link = waLink(inv.customerPhone || null, msg);
    window.open(link, "_blank", "noopener");
  });
  el.querySelector("#inv-sharepdf").addEventListener("click", async () => {
    const box = el.querySelector("#inv-msg");
    try {
      const bytes = buildInvoicePdfBytes(inv, state.business || {});
      const file = new File([bytes], `${inv.number}.pdf`, { type: "application/pdf" });
      if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: `Invoice ${inv.number}` });
      } else if (navigator.share) {
        await navigator.share({ title: `Invoice ${inv.number}`, text: invoiceBillText(inv, state.business || {}) });
      } else {
        if (box) box.innerHTML = `<div class="empty">Sharing not supported on this device — use Download PDF then attach it manually in WhatsApp.</div>`;
        else toast("Sharing not supported — use Download PDF.", "err");
      }
    } catch (e) {
      if (String(e && e.name) !== "AbortError") {
        if (box) box.innerHTML = `<div class="error">${esc(e.message || "Share failed.")}</div>`;
      }
    }
  });
  const cancelBtn = el.querySelector("#inv-cancel");
  if (cancelBtn) cancelBtn.addEventListener("click", () => cancelInvoice(inv.id));
}
function receiptHtml(inv, business) {
  const L = [];
  L.push(`<div class="r-center"><strong>${esc(business.name || inv.businessName || "SmartBill")}</strong><br>${esc(business.address || "")}<br>${esc([business.phone, business.gstin ? "GSTIN: " + business.gstin : ""].filter(Boolean).join(" · "))}</div><div class="r-sep"></div>`);
  L.push(`<div>Bill: ${esc(inv.number)}<br>Date: ${esc(fmtDate(inv.date))}<br>Customer: ${esc(inv.customerName || "Walk-in")}</div><div class="r-sep"></div>`);
  const snap = Array.isArray(inv.itemsSnapshot) ? inv.itemsSnapshot : [];
  for (const it of snap) {
    if (!it || typeof it !== "object") continue;
    L.push(`<div>${esc(it.name)} x ${it.qty} @ ${safeINR(it.unitPricePaise)} = ${safeINR((it.taxable || 0) + (it.tax || 0))}</div>`);
  }
  L.push(`<div class="r-sep"></div>`);
  L.push(`<div>Total: ${safeINR(inv.totals ? inv.totals.grandTotal : undefined)}<br>Paid: ${safeINR(inv.paidPaise)} · Due: ${safeINR(inv.balancePaise)} (${esc(inv.status)})<br>Payment: ${esc(inv.paymentMethod)}</div><div class="r-sep"></div><div class="r-center">Thank you! Visit again.</div>`);
  return L.join("");
}
function doPrint(html, bodyClass) {
  const area = document.getElementById("print-area");
  if (!area) return;
  const token = ++printToken;
  document.body.classList.remove("print-58", "print-80", "print-a4");
  document.body.classList.add(bodyClass);
  area.innerHTML = html;
  try {
    window.print();
  } catch (e) {
    toast("Print failed: " + (e && e.message ? e.message : "not supported"), "err");
  }
  // Token-guarded so an earlier print's timer cannot wipe a newer print job.
  setTimeout(() => { if (token === printToken) cleanupPrint(); }, 500);
}
function cleanupPrint() {
  const area = document.getElementById("print-area");
  if (area) area.innerHTML = "";
  document.body.classList.remove("print-58", "print-80", "print-a4");
}
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("afterprint", cleanupPrint);
}
function printInvoice(inv, cls) {
  doPrint(receiptHtml(inv, state.business || {}), cls);
}
function cancelInvoice(id) {
  const inv = invoiceById(id);
  if (!inv || inv.status === "cancelled") return;
  const invNo = inv.number;
  if (!window.confirm(`Cancel invoice ${invNo}? This records a reversal and never deletes history.`)) return;
  // Re-read so reversals append to the latest ledger, not a stale copy.
  state = load();
  const freshInv = invoiceById(id);
  if (!freshInv || freshInv.status === "cancelled") { refresh(); return; }
  freshInv.status = "cancelled";
  const now = new Date().toISOString();
  if (freshInv.customerId) {
    const related = state.ledger.filter((t) => t && t.invoiceId === freshInv.id && (t.type === "credit_sale" || t.type === "payment"));
    for (const orig of related) {
      state.ledger.push({
        id: uid("txn"), customerId: orig.customerId, type: "reversal", amountPaise: -orig.amountPaise,
        invoiceId: freshInv.id, reason: `Reversal of ${orig.type} for cancelled invoice ${invNo}`,
        reversesId: orig.id, createdAt: now, createdBy: "local-user",
      });
    }
  }
  if (!persist()) { state = load(); return; }
  toast(`Invoice ${invNo} cancelled.`);
  refresh();
}

/* ---------- customers ---------- */
function renderCustomers() {
  const el = document.getElementById("customers-app");
  if (!el) return;
  let html = `<h2>Customers</h2>
  <div class="card"><strong>Add customer</strong><div id="cus-err"></div>
    <div class="field"><label>Name *</label><input id="c-name" class="input" placeholder="e.g. Ramesh Kumar"></div>
    <div class="field"><label>Phone (optional, 10-digit Indian mobile)</label><input id="c-phone" class="input" placeholder="e.g. 9876543210" inputmode="tel"></div>
    <div class="field"><label>Opening balance (₹)</label><input id="c-open" class="input" placeholder="0" inputmode="decimal"></div>
    <div class="field"><label>Notes</label><input id="c-notes" class="input"></div>
    <button class="btn btn-primary" id="c-add">Add customer</button></div>
  <div class="card"><div class="field"><label>Search customers</label><input id="c-search" class="input" value="${esc(customerListSearch)}" placeholder="Name or phone"></div>
  <div id="c-list"></div></div>`;
  el.innerHTML = html;
  const draw = () => {
    const q = customerListSearch.trim().toLowerCase();
    const list = state.customers.filter((c) => !q || (c.name + " " + (c.phone || "")).toLowerCase().includes(q));
    const box = el.querySelector("#c-list");
    if (list.length === 0) {
      box.innerHTML = `<div class="empty">${state.customers.length === 0 ? "No customers yet. Add your first customer above." : "No customers match."}</div>`;
      return;
    }
    let t = `<div class="table-wrap"><table class="table"><thead><tr><th>Name</th><th>Phone</th><th>Outstanding</th><th></th></tr></thead><tbody>`;
    for (const c of list) {
      t += `<tr><td>${esc(c.name)}</td><td>${esc(c.phone || "—")}</td><td>${formatINR(customerOutstanding(state, c.id))}</td><td><a href="#/customer/${esc(c.id)}">View</a></td></tr>`;
    }
    t += `</tbody></table></div>`;
    box.innerHTML = t;
  };
  el.querySelector("#c-search").addEventListener("input", (e) => { customerListSearch = e.target.value; draw(); });
  el.querySelector("#c-add").addEventListener("click", () => {
    const errBox = el.querySelector("#cus-err");
    const name = el.querySelector("#c-name").value;
    const phone = el.querySelector("#c-phone").value;
    const openRaw = el.querySelector("#c-open").value;
    const notes = el.querySelector("#c-notes").value;
    let openingPaise = 0;
    try {
      openingPaise = String(openRaw || "").trim() === "" ? 0 : toPaise(openRaw);
    } catch (e) {
      errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`;
      return;
    }
    const errs = validateCustomer({ name, phone, openingPaise });
    if (errs.length) {
      errBox.innerHTML = `<div class="error">${errs.map(esc).join("<br>")}</div>`;
      return;
    }
    state = load();
    state.customers.push({ id: uid("cus"), name: String(name).trim(), phone: String(phone || "").trim(), openingPaise, notes: String(notes || "").trim(), createdAt: new Date().toISOString() });
    if (!persist()) { state = load(); return; }
    toast("Customer added.");
    refresh();
  });
  draw();
}
function renderCustomerDetail(id) {
  const el = document.getElementById("customer-detail-app");
  if (!el) return;
  payKey = uid("pay");
  const c = customerById(id);
  if (!c) {
    el.innerHTML = `<h2>Customer</h2><div class="error">Customer not found.</div><p><a href="#/customers">Back to customers</a></p>`;
    return;
  }
  const txns = state.ledger.filter((t) => t.customerId === c.id).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const sum = summarize(c.openingPaise || 0, txns);
  const outInvs = state.invoices.filter((i) => i.customerId === c.id && i.status !== "cancelled" && i.balancePaise > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  let html = `<p><a href="#/customers">← Back to customers</a></p><h2>${esc(c.name)}</h2>`;
  html += `<div class="card"><div>Phone: ${esc(c.phone || "—")}</div>${c.notes ? `<div>Notes: ${esc(c.notes)}</div>` : ""}</div>`;
  html += `<div class="card"><strong>Summary (recomputed from ledger)</strong>
    <div class="table-wrap"><table class="table"><tbody>
    <tr><td>Opening</td><td>${formatINR(sum.opening)}</td></tr>
    <tr><td>Credit sales</td><td>${formatINR(sum.creditSales)}</td></tr>
    <tr><td>Payments received</td><td>${formatINR(sum.payments)}</td></tr>
    <tr><td>Adjustments</td><td>${formatINR(sum.adjustments)}</td></tr>
    <tr><td><strong>Outstanding</strong></td><td><strong>${formatINR(sum.outstanding)}</strong></td></tr>
    </tbody></table></div></div>`;
  html += `<div class="card"><strong>Outstanding invoices (${outInvs.length})</strong>`;
  if (outInvs.length === 0) html += `<div class="empty">No outstanding invoices.</div>`;
  else {
    html += `<div class="table-wrap"><table class="table"><thead><tr><th>Number</th><th>Date</th><th>Total</th><th>Paid</th><th>Due</th><th></th></tr></thead><tbody>`;
    for (const inv of outInvs) html += `<tr><td>${esc(inv.number)}</td><td>${esc(fmtDay(inv.date))}</td><td>${safeINR(inv.totals ? inv.totals.grandTotal : undefined)}</td><td>${safeINR(inv.paidPaise)}</td><td>${safeINR(inv.balancePaise)}</td><td><a href="#/invoice/${esc(inv.id)}">View</a></td></tr>`;
    html += `</tbody></table></div>`;
  }
  html += `</div>`;
  html += `<div class="card"><strong>Transactions (${txns.length})</strong>`;
  if (txns.length === 0) html += `<div class="empty">No transactions yet. Opening balance ${formatINR(c.openingPaise || 0)}.</div>`;
  else {
    html += `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Type</th><th>Invoice</th><th>Amount</th><th>Reason/Note</th></tr></thead><tbody>`;
    for (const t of [...txns].reverse()) {
      const invNo = t.invoiceId ? (invoiceById(t.invoiceId)?.number || t.invoiceId) : "—";
      html += `<tr><td>${esc(fmtDay(t.createdAt))}</td><td>${esc(t.type)}</td><td>${esc(invNo)}</td><td>${safeINR(t.amountPaise)}</td><td>${esc(t.reason || t.note || "")}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }
  html += `</div>`;
  // payment form
  html += `<div class="card"><strong>Record payment</strong><div id="pay-err"></div>
    <div class="field"><label>Amount (₹) *</label><input id="pay-amt" class="input" placeholder="e.g. 500" inputmode="decimal"></div>
    <div class="field"><label>Link to invoice (optional)</label><select id="pay-inv" class="input"><option value="">No specific invoice (adjust outstanding)</option>`;
  for (const inv of outInvs) html += `<option value="${esc(inv.id)}">${esc(inv.number)} — due ${safeINR(inv.balancePaise)}</option>`;
  html += `</select></div>
    <div class="field"><label>Note (optional)</label><input id="pay-note" class="input"></div>
    <button class="btn btn-primary" id="pay-go">Record payment</button></div>`;
  // adjustment form
  html += `<div class="card"><strong>Adjustment (discount / correction)</strong><div id="adj-err"></div>
    <div class="field"><label>Amount signed (₹) * — use minus for discount, e.g. -100</label><input id="adj-amt" class="input" placeholder="e.g. -100 or 50" inputmode="text"></div>
    <div class="field"><label>Reason *</label><input id="adj-reason" class="input" placeholder="e.g. Festival discount"></div>
    <button class="btn" id="adj-go">Record adjustment</button></div>`;
  html += `<div class="card"><div class="row-flex"><button class="btn" id="cus-stmt">Print statement (A4)</button><button class="btn" id="cus-remind">WhatsApp reminder</button></div><div id="cus-msg"></div></div>`;
  el.innerHTML = html;

  el.querySelector("#pay-go").addEventListener("click", () => {
    const errBox = el.querySelector("#pay-err");
    const amtRaw = el.querySelector("#pay-amt").value;
    const note = el.querySelector("#pay-note").value;
    const invId = el.querySelector("#pay-inv").value || null;
    let amountPaise = 0;
    try { amountPaise = toPaise(amtRaw); }
    catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
    // re-read state, recompute outstanding (never trust input)
    const fresh = load();
    const fc = fresh.customers.find((x) => x.id === c.id);
    if (!fc) { errBox.innerHTML = `<div class="error">Customer no longer exists.</div>`; return; }
    const outstanding = customerOutstanding(fresh, fc.id);
    const vErr = validateCollection({ outstandingPaise: outstanding, amountPaise, idempotencyKey: payKey, usedKeys: fresh.usedKeys || [] });
    if (vErr) { errBox.innerHTML = `<div class="error">${esc(vErr)}</div>`; return; }
    if (!window.confirm(`Record payment of ${formatINR(amountPaise)} from ${fc.name}?`)) return;
    const now = new Date().toISOString();
    fresh.ledger.push({ id: uid("txn"), customerId: fc.id, type: "payment", amountPaise: -amountPaise, invoiceId: invId || undefined, note: String(note || "").trim() || undefined, createdAt: now, createdBy: "local-user" });
    if (invId) {
      const inv = fresh.invoices.find((i) => i.id === invId);
      if (inv && inv.status !== "cancelled") {
        const apply = Math.min(amountPaise, inv.balancePaise);
        inv.paidPaise += apply;
        if (inv.paidPaise > inv.totals.grandTotal) inv.paidPaise = inv.totals.grandTotal;
        inv.balancePaise = inv.totals.grandTotal - inv.paidPaise;
        inv.status = paymentStatus(inv.totals.grandTotal, inv.paidPaise);
      }
    }
    fresh.usedKeys = [...(fresh.usedKeys || []), payKey];
    if (!persist(fresh)) return;
    state = fresh;
    toast(`Payment ${formatINR(amountPaise)} recorded.`);
    refresh();
  });
  el.querySelector("#adj-go").addEventListener("click", () => {
    const errBox = el.querySelector("#adj-err");
    const amtRaw = el.querySelector("#adj-amt").value;
    const reason = el.querySelector("#adj-reason").value;
    let amountPaise = 0;
    try { amountPaise = parseSignedPaise(amtRaw); }
    catch (e) { errBox.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
    if (!String(reason || "").trim()) { errBox.innerHTML = `<div class="error">Reason is required for adjustments.</div>`; return; }
    if (!window.confirm(`Record adjustment of ${formatINR(amountPaise)}?`)) return;
    // Write to a fresh copy like payments do, so a stale view cannot silently
    // drop sales recorded elsewhere (e.g. another tab) on save.
    const fresh = load();
    if (!fresh.customers.find((x) => x.id === c.id)) { errBox.innerHTML = `<div class="error">Customer no longer exists.</div>`; return; }
    fresh.ledger.push({ id: uid("txn"), customerId: c.id, type: "adjustment", amountPaise, reason: String(reason).trim(), createdAt: new Date().toISOString(), createdBy: "local-user" });
    if (!persist(fresh)) return;
    state = fresh;
    toast("Adjustment recorded.");
    refresh();
  });
  el.querySelector("#cus-stmt").addEventListener("click", () => {
    const txnsNow = state.ledger.filter((t) => t.customerId === c.id);
    const s = summarize(c.openingPaise || 0, txnsNow);
    let h = `<div class="r-center"><strong>${esc((state.business && state.business.name) || "SmartBill")}</strong><br>Customer statement — ${esc(c.name)}<br>${esc(c.phone || "")}</div><div class="r-sep"></div>`;
    h += `<div>Opening: ${safeINR(s.opening)}<br>Credit sales: ${safeINR(s.creditSales)}<br>Payments: ${safeINR(s.payments)}<br>Adjustments: ${safeINR(s.adjustments)}<br><strong>Outstanding: ${safeINR(s.outstanding)}</strong></div><div class="r-sep"></div>`;
    for (const t of txnsNow) h += `<div>${esc(fmtDay(t.createdAt))} · ${esc(t.type)} · ${safeINR(t.amountPaise)} · ${esc(t.reason || t.note || "")}</div>`;
    doPrint(h, "print-a4");
  });
  el.querySelector("#cus-remind").addEventListener("click", () => {
    const out = customerOutstanding(state, c.id);
    const msg = reminderMessage(c.name, out);
    window.open(waLink(c.phone || null, msg), "_blank", "noopener");
  });
}

/* ---------- ledger ---------- */
function renderLedger() {
  const el = document.getElementById("ledger-app");
  if (!el) return;
  let html = `<h2>Credit Ledger</h2>
  <div class="card"><div class="field"><label>Filter by customer</label><select id="led-filter" class="input"><option value="">All customers</option>`;
  for (const c of state.customers) html += `<option value="${esc(c.id)}"${ledgerFilter === c.id ? " selected" : ""}>${esc(c.name)}</option>`;
  html += `</select></div><small>Balances are recomputed from transactions, never trusted from input.</small></div><div id="led-table"></div>`;
  el.innerHTML = html;
  const draw = () => {
    const list = state.ledger.filter((t) => !ledgerFilter || t.customerId === ledgerFilter)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const box = el.querySelector("#led-table");
    if (list.length === 0) {
      box.innerHTML = `<div class="empty">${state.ledger.length === 0 ? "No ledger entries yet. Credit sales appear here when you sell on credit." : "No entries for this filter."}</div>`;
      return;
    }
    let t = `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Customer</th><th>Type</th><th>Invoice</th><th>Amount</th><th>Reason/Note</th></tr></thead><tbody>`;
    for (const txn of list) {
      const cn = customerById(txn.customerId)?.name || txn.customerId;
      const invNo = txn.invoiceId ? (invoiceById(txn.invoiceId)?.number || txn.invoiceId) : "—";
      t += `<tr><td>${esc(fmtDay(txn.createdAt))}</td><td>${esc(cn)}</td><td>${esc(txn.type)}</td><td>${esc(invNo)}</td><td>${safeINR(txn.amountPaise)}</td><td>${esc(txn.reason || txn.note || "")}</td></tr>`;
    }
    t += `</tbody></table></div>`;
    box.innerHTML = t;
  };
  el.querySelector("#led-filter").addEventListener("change", (e) => { ledgerFilter = e.target.value; draw(); });
  draw();
}

/* ---------- settings ---------- */
function renderSettings() {
  const el = document.getElementById("settings-app");
  if (!el) return;
  const b = state.business || {};
  let html = `<h2>Settings</h2>
  <div class="card"><strong>Business details</strong><div id="set-err"></div>
    <div class="field"><label>Shop name</label><input id="s-name" class="input" value="${esc(b.name || "")}"></div>
    <div class="field"><label>Address</label><input id="s-addr" class="input" value="${esc(b.address || "")}"></div>
    <div class="row-flex"><div class="field" style="flex:1"><label>Phone</label><input id="s-phone" class="input" value="${esc(b.phone || "")}"></div>
    <div class="field" style="flex:1"><label>Email</label><input id="s-email" class="input" value="${esc(b.email || "")}"></div></div>
    <div class="field"><label>GSTIN</label><input id="s-gstin" class="input" value="${esc(b.gstin || "")}" placeholder="e.g. 22AAAAA0000A1Z5"></div>
    <small>Enter your real GSTIN from your registration — the app never invents one. GST invoice legal compliance needs your CA's verification.</small>
    <div class="row-flex" style="margin-top:10px">
      <div class="field" style="flex:1"><label>Tax mode</label><select id="s-taxmode" class="input">
        <option value="non-gst"${b.taxMode === "non-gst" ? " selected" : ""}>Non-GST</option>
        <option value="gst"${b.taxMode === "gst" ? " selected" : ""}>GST</option></select></div>
      <div class="field" style="flex:1"><label>GST type</label><select id="s-gsttype" class="input">
        <option value="intrastate"${b.gstType === "intrastate" ? " selected" : ""}>Intrastate (CGST+SGST)</option>
        <option value="interstate"${b.gstType === "interstate" ? " selected" : ""}>Interstate (IGST)</option></select></div>
      <div class="field" style="flex:1"><label>Prices include tax?</label><select id="s-incl" class="input">
        <option value="no"${!b.priceIncludesTax ? " selected" : ""}>No — add tax on top</option>
        <option value="yes"${b.priceIncludesTax ? " selected" : ""}>Yes — price includes tax</option></select></div>
    </div>
    <div style="margin-top:10px"><button class="btn btn-primary" id="s-save">Save settings</button></div></div>
  <div class="card"><strong>Fresh start</strong>
    <div>Deletes <strong>everything</strong> on this device — bills, customers, ledger and settings — and starts over. This cannot be undone.</div>
    <div style="margin-top:10px"><button class="btn btn-danger" id="s-reset">Delete all data</button></div></div>
  <div class="card"><strong>Data backup</strong>
    <div>Your data lives only on this device. Download a backup file regularly — if browser data is ever cleared, this file is the only way back.</div>
    <div class="row-flex" style="margin-top:10px"><button class="btn" id="s-export">Download backup</button>
    <label class="btn" for="s-importfile">Restore backup</label><input type="file" id="s-importfile" accept="application/json,.json" style="display:none"></div>
    <div id="s-backupmsg" style="margin-top:8px"></div></div>
  <div class="card"><strong>How to use SmartBill</strong>
    <div>1. <strong>New Bill</strong> — type items, apply discount once, take payment, Complete Sale.<br>
    2. <strong>Invoices</strong> — download PDF, print a 58/80mm receipt, or Send Bill on WhatsApp.<br>
    3. <strong>Customers</strong> — credit sales build khata; Record Payment collects, history shows everything.<br>
    4. <strong>Credit Ledger</strong> — every balance is recomputed from transactions; nothing is deleted, only reversed.<br>
    5. <strong>Settings</strong> — shop details, GST mode, backups, fresh start.</div>
    <div style="margin-top:8px"><small>Tip: download a backup after every busy day.</small></div></div>`;
  el.innerHTML = html;
  el.querySelector("#s-save").addEventListener("click", () => {
    state = load();
    state.business = {
      ...state.business,
      name: el.querySelector("#s-name").value.trim() || "My Shop",
      address: el.querySelector("#s-addr").value.trim(),
      phone: el.querySelector("#s-phone").value.trim(),
      email: el.querySelector("#s-email").value.trim(),
      gstin: el.querySelector("#s-gstin").value.trim(),
      taxMode: el.querySelector("#s-taxmode").value,
      gstType: el.querySelector("#s-gsttype").value,
      priceIncludesTax: el.querySelector("#s-incl").value === "yes",
    };
    if (!persist()) { state = load(); return; }
    toast("Settings saved.");
    refresh();
  });
  el.querySelector("#s-reset").addEventListener("click", () => {
    if (!window.confirm("Delete ALL SmartBill data on this device (bills, customers, ledger, settings)? This cannot be undone.")) return;
    if (!window.confirm("Really sure? Tap OK to wipe everything and start fresh.")) return;
    localStorage.removeItem(KEY);
    window.location.hash = "#/dashboard";
    window.location.reload();
  });
  el.querySelector("#s-export").addEventListener("click", () => {
    try {
      const blob = new Blob([JSON.stringify(state)], { type: "application/json" });
      const day = new Date().toISOString().slice(0, 10);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `smartbill-backup-${day}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      toast("Backup downloaded.");
    } catch (e) { toast("Backup failed: " + e.message, "err"); }
  });
  el.querySelector("#s-importfile").addEventListener("change", (e) => {
    const box = el.querySelector("#s-backupmsg");
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const data = JSON.parse(String(rd.result));
        if (!data || typeof data !== "object" || !Array.isArray(data.invoices) || !Array.isArray(data.customers) || !Array.isArray(data.ledger)) {
          throw new Error("Not a valid SmartBill backup file.");
        }
        if (!window.confirm(`Restore backup? This REPLACES all current data with ${data.invoices.length} invoice(s) from the file.`)) { e.target.value = ""; return; }
        const fresh = defaultState();
        if (data.business && typeof data.business === "object") fresh.business = { ...fresh.business, ...data.business };
        fresh.invoices = data.invoices; fresh.customers = data.customers; fresh.ledger = data.ledger;
        if (Array.isArray(data.products)) fresh.products = data.products;
        if (Array.isArray(data.usedKeys)) fresh.usedKeys = data.usedKeys;
        if (data.counters && typeof data.counters === "object") fresh.counters = { ...fresh.counters, ...data.counters };
        state = fresh;
        if (!persist()) { state = load(); box.innerHTML = `<div class="error">Restore failed: device storage is full.</div>`; return; }
        toast("Backup restored.");
        window.location.hash = "#/dashboard";
        refresh();
      } catch (err) {
        box.innerHTML = `<div class="error">${esc(err.message || "Restore failed.")}</div>`;
      }
      e.target.value = "";
    };
    rd.onerror = () => { box.innerHTML = `<div class="error">Could not read the file.</div>`; };
    rd.readAsText(f);
  });
}

/* ---------- init ---------- */
function init() {
  document.querySelectorAll("button[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-view");
      const map = { dashboard: "#/dashboard", newbill: "#/newbill", invoices: "#/invoices", customers: "#/customers", ledger: "#/ledger", settings: "#/settings" };
      window.location.hash = map[v] || "#/dashboard";
    });
  });
  window.addEventListener("hashchange", router);
  if (!window.location.hash) window.location.hash = "#/dashboard";
  router();
}
init();
