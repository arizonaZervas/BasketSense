"use client";

import { useState } from "react";

type Preview = {
  trip: { status: string; frozenAt: string | null; intentSnapshotId: string };
  counts: number[];
};

async function callReset(body: Record<string, unknown>) {
  const response = await fetch("/api/receipt-reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "Reset request failed");
  return result ?? {};
}

export default function ResetJuly25Page() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [message, setMessage] = useState("Preview the July 25 receipt reset before removing anything.");
  const [working, setWorking] = useState(false);

  async function previewReset() {
    setWorking(true);
    try {
      const result = await callReset({ action: "preview" });
      const nextPreview = result.preview as Preview;
      setPreview(nextPreview);
      setMessage("Preview complete. The frozen intent snapshot is present; the reset will preserve it.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview failed");
    } finally {
      setWorking(false);
    }
  }

  async function applyReset() {
    setWorking(true);
    try {
      await callReset({ action: "reset", confirmation: "RESET_JULY_25_RECEIPT" });
      const result = await callReset({ action: "preview" });
      setPreview(result.preview as Preview);
      setMessage("Reset verified: no July 25 receipt-side records or private upload artifacts remain.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Reset failed");
    } finally {
      setWorking(false);
    }
  }

  return (
    <main style={{ maxWidth: 680, margin: "4rem auto", fontFamily: "system-ui, sans-serif", padding: "0 1rem" }}>
      <h1>July 25 receipt reset</h1>
      <p>{message}</p>
      <button type="button" onClick={() => void previewReset()} disabled={working}>
        {working ? "Working…" : "Preview reset"}
      </button>
      {preview ? (
        <section aria-live="polite">
          <p>Trip state: {preview.trip.status}; frozen intent snapshot: present.</p>
          <p>
            Records to remove — receipts: {preview.counts[0]}, ingestions: {preview.counts[1]}, uploads: {preview.counts[2]},
            matches: {preview.counts[3]}, review questions: {preview.counts[4]}, receipt feedback: {preview.counts[5]}, outbox rows: {preview.counts[6]}.
          </p>
          <button type="button" onClick={() => void applyReset()} disabled={working}>
            Reset July 25 receipt
          </button>
        </section>
      ) : null}
    </main>
  );
}
