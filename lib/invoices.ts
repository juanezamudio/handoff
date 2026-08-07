/**
 * Demo fixture data for the accounts-payable agent.
 *
 * IMPORTANT: the two escalations are NOT scripted. The system prompt states the
 * approval policy and the escalation principle only. These records are shaped so
 * that exactly two invoices violate the policy in ways the model cannot resolve
 * from the data available to it:
 *
 *   INV-2041 — vendor name doesn't match the approved list AND the bank account
 *              differs from the one on file. Rebrand or impersonation? Only a
 *              human knows. (missing INFORMATION)
 *   INV-2044 — 18.1% over PO against a 10% cap, overage is a single expedited
 *              freight line. A judgment call with money on both sides.
 *              (missing AUTHORITY)
 *
 * Everything else passes cleanly. Never add case-specific instructions to the
 * prompt — if you do, the demo becomes an if-statement wearing an LLM costume
 * and it will not survive Q&A.
 */

export type Invoice = {
  id: string;
  vendor: string;
  amount: number;
  poNumber: string;
  poAmount: number;
  bankLast4: string;
  lineItems: { description: string; amount: number }[];
};

export type ApprovedVendor = {
  name: string;
  bankLast4: string;
};

/** Vendors we are allowed to pay, and the bank account we have on file for each. */
export const APPROVED_VENDORS: ApprovedVendor[] = [
  { name: "Northwind Logistics", bankLast4: "1180" },
  { name: "Kestrel Print", bankLast4: "6620" },
  { name: "Bayline Materials", bankLast4: "3391" },
  { name: "Delta Fabrication", bankLast4: "7745" },
  { name: "Acme Supply Co.", bankLast4: "4471" },
];

export const INVOICES: Invoice[] = [
  {
    id: "INV-2038",
    vendor: "Northwind Logistics",
    amount: 3200,
    poNumber: "PO-8801",
    poAmount: 3200,
    bankLast4: "1180",
    lineItems: [{ description: "Freight — Sept week 1", amount: 3200 }],
  },
  {
    id: "INV-2039",
    vendor: "Kestrel Print",
    amount: 890,
    poNumber: "PO-8804",
    poAmount: 890,
    bankLast4: "6620",
    lineItems: [{ description: "Catalog reprint, 500 units", amount: 890 }],
  },
  {
    id: "INV-2040",
    vendor: "Bayline Materials",
    amount: 6750,
    poNumber: "PO-8809",
    poAmount: 7000,
    bankLast4: "3391",
    lineItems: [{ description: "Steel stock, partial delivery", amount: 6750 }],
  },
  {
    // STOP 1 — vendor name mismatch + changed bank details.
    id: "INV-2041",
    vendor: "ACME Supplies Inc.",
    amount: 4100,
    poNumber: "PO-8812",
    poAmount: 4100,
    bankLast4: "9982",
    lineItems: [{ description: "Packaging consumables Q3", amount: 4100 }],
  },
  {
    id: "INV-2042",
    vendor: "Northwind Logistics",
    amount: 1450,
    poNumber: "PO-8815",
    poAmount: 1450,
    bankLast4: "1180",
    lineItems: [{ description: "Freight — Sept week 2", amount: 1450 }],
  },
  {
    id: "INV-2043",
    vendor: "Delta Fabrication",
    amount: 9800,
    poNumber: "PO-8818",
    poAmount: 10000,
    bankLast4: "7745",
    lineItems: [{ description: "Bracket run, 2,000 units", amount: 9800 }],
  },
  {
    // STOP 2 — 18.1% over PO against a 10% cap; overage is one freight line.
    id: "INV-2044",
    vendor: "Bayline Materials",
    amount: 12400,
    poNumber: "PO-8821",
    poAmount: 10500,
    bankLast4: "3391",
    lineItems: [
      { description: "Steel stock, balance of PO-8821", amount: 10500 },
      { description: "Expedited freight — customer requested", amount: 1900 },
    ],
  },
  {
    id: "INV-2045",
    vendor: "Kestrel Print",
    amount: 2300,
    poNumber: "PO-8824",
    poAmount: 2300,
    bankLast4: "6620",
    lineItems: [{ description: "Trade show signage", amount: 2300 }],
  },
];

/** Rendered into the system prompt so the model sees the same data a clerk would. */
export function renderReferenceData(): string {
  const vendors = APPROVED_VENDORS.map(
    (v) => `  - ${v.name} — bank account on file ending ${v.bankLast4}`,
  ).join("\n");

  const invoices = INVOICES.map((inv) => {
    const lines = inv.lineItems
      .map((li) => `      * ${li.description}: $${li.amount.toLocaleString()}`)
      .join("\n");
    return [
      `  ${inv.id}`,
      `    vendor: ${inv.vendor}`,
      `    total: $${inv.amount.toLocaleString()}`,
      `    purchase order: ${inv.poNumber} for $${inv.poAmount.toLocaleString()}`,
      `    remit to bank account ending: ${inv.bankLast4}`,
      `    line items:`,
      lines,
    ].join("\n");
  }).join("\n\n");

  return `APPROVED VENDOR LIST\n${vendors}\n\nINVOICES AWAITING APPROVAL\n${invoices}`;
}
