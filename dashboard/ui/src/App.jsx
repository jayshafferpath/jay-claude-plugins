import { useState, useEffect, useCallback } from "react";
import { FeatureBranchStacks } from "./FeatureBranchStacks.jsx";
import { StackOverview } from "./StackOverview.jsx";
import { StackList } from "./StackList.jsx";
import { SummaryBar } from "./SummaryBar.jsx";
import { StagnationPanel } from "./StagnationPanel.jsx";
import { QueueView } from "./QueueView.jsx";

export function App() {
  const [stacks, setStacks] = useState([]);
  const [queues, setQueues] = useState(null);
  const [stagnation, setStagnation] = useState(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchStacks = useCallback(async () => {
    try {
      const res = await fetch("/api/stacks");
      if (!res.ok) throw new Error(`API error: ${res.status}`);
      const data = await res.json();
      setStacks(data.stacks);
      setQueues(data.queues || null);
      setStagnation(data.stagnation || null);
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

    // Pause polling while the tab is hidden. Each tick does real work (a gh
    // call per repo), and a backgrounded dashboard left open all day has no
    // reason to keep paying for it.
    let interval = null;
    const start = () => {
      if (interval === null) interval = setInterval(fetchStacks, 10000);
    };
    const stop = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchStacks();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetchStacks]);

  const handleAction = async (action, key) => {
    const endpoints = {
      "drift-check": `/api/tickets/${key}/drift-check`,
    };
    const endpoint = endpoints[action];
    if (!endpoint) return;
    await fetch(endpoint, { method: "POST" });
    await fetchStacks();
  };

  if (loading) return <div className="loading">Loading stacks...</div>;
  if (error) return <div className="error">Error: {error}</div>;

  const allTickets = stacks.flatMap((s) => s.tickets);

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
        queues={queues}
        stalled={stagnation?.counts?.total || 0}
      />

      <StagnationPanel stagnation={stagnation} jiraBaseUrl={jiraBaseUrl} />

      {stacks.length === 0 ? (
        <div className="empty">No active Claude tickets found.</div>
      ) : (
        <>
          <QueueView stacks={stacks} queues={queues} jiraBaseUrl={jiraBaseUrl} />
          <FeatureBranchStacks stacks={stacks} jiraBaseUrl={jiraBaseUrl} onAction={handleAction} />
          <StackOverview stacks={stacks} jiraBaseUrl={jiraBaseUrl} />
          <StackList stacks={stacks} onAction={handleAction} jiraBaseUrl={jiraBaseUrl} />
        </>
      )}
    </div>
  );
}
