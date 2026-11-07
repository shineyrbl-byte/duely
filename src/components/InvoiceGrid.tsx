"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type ColDef,
  type ICellRendererParams,
  type RowClassParams,
} from "ag-grid-community";
import type { InvoiceRow } from "@/lib/types";
import { fmtMoney, postJson } from "./api";

ModuleRegistry.registerModules([AllCommunityModule]);

const theme = themeQuartz.withParams({
  accentColor: "#4f46e5",
  borderColor: "#e6e8ef",
  headerBackgroundColor: "#fafbfc",
  headerTextColor: "#667085",
  fontFamily: "inherit",
  fontSize: 13,
  rowHeight: 48,
  wrapperBorderRadius: 12,
});

const HEALTH_STYLE: Record<InvoiceRow["health"], string> = {
  Paid: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Overdue: "bg-red-50 text-red-700 ring-red-200",
  "Due soon": "bg-amber-50 text-amber-800 ring-amber-200",
  Open: "bg-sky-50 text-sky-700 ring-sky-200",
  Draft: "bg-gray-50 text-gray-600 ring-gray-200",
  Cancelled: "bg-gray-50 text-gray-400 ring-gray-200",
};

const FILTERS = ["All", "Overdue", "Due soon", "Open", "Paid"] as const;

interface Props {
  rows: InvoiceRow[];
  mock: boolean;
  onChange: () => void;
  onError: (msg: string) => void;
}

export default function InvoiceGrid({ rows, mock, onChange, onError }: Props) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  async function act(row: InvoiceRow, action: string) {
    setBusyId(row.id);
    try {
      await postJson(`/api/invoices/${row.id}/${action}`);
      onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  const visible = useMemo(() => (filter === "All" ? rows : rows.filter((r) => r.health === filter)), [rows, filter]);

  const columnDefs = useMemo<ColDef<InvoiceRow>[]>(
    () => [
      { field: "number", headerName: "Invoice", width: 105, cellClass: "font-mono text-xs" },
      {
        field: "clientName",
        headerName: "Client",
        flex: 1.4,
        minWidth: 170,
        cellRenderer: (p: ICellRendererParams<InvoiceRow>) => (
          <div className="flex flex-col justify-center leading-tight">
            <span className="font-medium">{p.data?.clientName}</span>
            <span className="text-xs text-muted">{p.data?.clientBusiness ?? p.data?.clientEmail}</span>
          </div>
        ),
      },
      {
        field: "health",
        headerName: "Status",
        width: 115,
        cellRenderer: (p: ICellRendererParams<InvoiceRow>) =>
          p.data ? (
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${HEALTH_STYLE[p.data.health]}`}>{p.data.health}</span>
          ) : null,
      },
      {
        field: "total",
        headerName: "Total",
        width: 115,
        type: "rightAligned",
        valueFormatter: (p) => (p.data ? fmtMoney(p.data.total, p.data.currency) : ""),
      },
      {
        field: "amountDue",
        headerName: "Outstanding",
        width: 125,
        type: "rightAligned",
        valueFormatter: (p) => (p.data ? fmtMoney(p.data.amountDue, p.data.currency) : ""),
        cellClass: "font-medium",
      },
      { field: "dueDate", headerName: "Due date", width: 115, sort: "asc" },
      {
        field: "daysOverdue",
        headerName: "Overdue",
        width: 100,
        valueFormatter: (p) => {
          const d = p.value as number | null;
          if (d === null || !p.data || ["Paid", "Cancelled", "Draft"].includes(p.data.health)) return "—";
          return d > 0 ? `${d}d late` : d === 0 ? "today" : `in ${-d}d`;
        },
        cellClassRules: { "text-red-600 font-medium": (p) => p.data?.health === "Overdue" },
      },
      { field: "remindersSent", headerName: "Nudges", width: 90, type: "rightAligned" },
      {
        headerName: "",
        colId: "actions",
        width: 250,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<InvoiceRow>) => {
          const r = p.data;
          if (!r) return null;
          const open = ["Overdue", "Due soon", "Open"].includes(r.health);
          const busy = busyId === r.id;
          return (
            <div className="flex h-full items-center gap-1.5">
              {open && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(r, "remind")}>
                  Remind
                </button>
              )}
              {open && mock && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(r, "simulate-payment")} title="Demo mode: simulate the client paying">
                  Client pays
                </button>
              )}
              {open && !mock && r.payerUrl && (
                <a className="btn btn-ghost btn-sm" href={r.payerUrl} target="_blank" rel="noreferrer" title="Open the PayPal payer page (sandbox)">
                  Pay link ↗
                </a>
              )}
              {open && (
                <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => act(r, "mark-paid")} title="Record a bank transfer or cash payment">
                  Mark paid
                </button>
              )}
            </div>
          );
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busyId, mock],
  );

  return (
    <section className="card p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-2 text-base font-semibold">Invoices</h2>
        {FILTERS.map((f) => {
          const n = f === "All" ? rows.length : rows.filter((r) => r.health === f).length;
          return (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${filter === f ? "bg-foreground text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"}`}
            >
              {f} <span className="opacity-60">{n}</span>
            </button>
          );
        })}
        <div className="flex-1" />
        <input className="input !w-56" placeholder="Search clients, invoice #…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div style={{ height: 420 }}>
        <AgGridReact<InvoiceRow>
          theme={theme}
          rowData={visible}
          columnDefs={columnDefs}
          getRowId={(p) => p.data.id}
          quickFilterText={search}
          defaultColDef={{ sortable: true, resizable: true }}
          rowClassRules={{ "opacity-50": (p: RowClassParams<InvoiceRow>) => p.data?.health === "Cancelled" }}
          overlayNoRowsTemplate="No invoices yet — draft one above or load demo data."
        />
      </div>
    </section>
  );
}
