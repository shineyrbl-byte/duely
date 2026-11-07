// Shared types used by the API routes and the UI.

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_PAID"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED"
  | "UNPAID"
  | "PAYMENT_PENDING";

/** A PayPal invoice flattened into the shape the dashboard needs. */
export interface InvoiceRow {
  id: string;
  number: string;
  status: InvoiceStatus;
  /** Derived label for the UI: Paid, Overdue, Due soon, Open, Draft, Cancelled. */
  health: "Paid" | "Overdue" | "Due soon" | "Open" | "Draft" | "Cancelled";
  clientName: string;
  clientEmail: string;
  clientBusiness: string | null;
  currency: string;
  total: number;
  amountDue: number;
  invoiceDate: string;
  dueDate: string | null;
  /** Positive = days past due, negative = days until due. Null when no due date. */
  daysOverdue: number | null;
  payerUrl: string | null;
  remindersSent: number;
  lastReminderAt: string | null;
}

export interface DraftItem {
  name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  unit: "HOURS" | "QUANTITY" | "AMOUNT";
}

/** What the AI produces from messy input, and what the review form edits. */
export interface InvoiceDraft {
  client_name: string;
  client_email: string | null;
  client_business: string | null;
  currency: string;
  items: DraftItem[];
  tax_percent: number | null;
  discount_percent: number | null;
  due_date: string;
  note_to_client: string;
  missing_info: string[];
  reasoning_summary: string;
}

export interface ReminderProposal {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  clientName: string;
  amountDue: number;
  currency: string;
  daysOverdue: number | null;
  urgency: "heads-up" | "gentle" | "firm" | "final";
  subject: string;
  note: string;
  reasoning: string;
  status: "pending" | "sent" | "dismissed" | "failed";
  error?: string;
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  at: string;
  kind: "invoice" | "reminder" | "payment" | "agent" | "webhook" | "error";
  message: string;
}
