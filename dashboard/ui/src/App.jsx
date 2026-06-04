import { useState, useEffect, useCallback } from "react";
import { StackOverview } from "./StackOverview.jsx";
import { StackList } from "./StackList.jsx";
import { SummaryBar } from "./SummaryBar.jsx";

export function App() {
  const [stacks, setStacks] = useState([]);
  const [jiraBaseUrl, setJiraBaseUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStacks = useCallback(async () => {
    try {
      const res = await fetch("/api/stacks");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setStacks(data.stacks);
      setJiraBaseUrl(data.jiraBaseUrl);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStacks();
    const interval = setInterval(fetchStacks, 10000);
    return () => clearInterval(interval);
  }, [fetchStacks]);

  const handleAction = async (action, key) => {
    const endpoints = {
      "approve-plan": `/api/tickets/${key}/approve-plan`,
      "approve-pr": `/api/tickets/${key}/approve-pr`,
    };
    await fetch(endpoints[action], { method: "POST" });
    await fetchStacks();
  };

  if (loading) return <div className="loading">Loading stacks...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  const allTickets = stacks.flatMap((s) => s.tickets);
  const plansPending = allTickets.filter(
    (t) => t.stateLabel === "ClaudePlanNeedsApproval"
  );
  const prsPending = allTickets.filter(
    (t) => t.stateLabel === "ClaudeStackReady"
  );
  const failed = allTickets.filter((t) => t.stateLabel === "ClaudeFailed");

  return (
    <div className="dashboard">
      <div className="header">
        <h1>Ticket Dashboard</h1>
        <div className="header-actions">
          <button className="btn" onClick={fetchStacks}>
            Refresh
          </button>
        </div>
      </div>

      <SummaryBar
        total={allTickets.length}
        stackCount={stacks.length}
        plansPending={plansPending.length}
        prsPending={prsPending.length}
        failed={failed.length}
      />

      {stacks.length === 0 ? (
        <div className="empty">No active Claude tickets found.</div>
      ) : (
        <>
          <StackOverview stacks={stacks} jiraBaseUrl={jiraBaseUrl} />
          <StackList stacks={stacks} onAction={handleAction} jiraBaseUrl={jiraBaseUrl} />
        </>
      )}
    </div>
  );
}
