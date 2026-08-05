import { useState, useEffect, useCallback } from "react";
import { FeatureBranchStacks } from "./FeatureBranchStacks.jsx";
import { StackOverview } from "./StackOverview.jsx";
import { StackList } from "./StackList.jsx";
import { SummaryBar } from "./SummaryBar.jsx";
import { StagnationPanel } from "./StagnationPanel.jsx";
import { QueueView } from "./QueueView.jsx";
import { JobsPanel } from "./JobsPanel.jsx";
import { BacklogPanel } from "./BacklogPanel.jsx";
import { HygienePanel } from "./HygienePanel.jsx";
import { TimelinePanel } from "./TimelinePanel.jsx";

export function App() {
  const [stacks, setStacks] = useState([]);
  const [queues, setQueues] = useState(null);
  const [stagnation, setStagnation] = useState(null);
  const [jiraBaseUrl, setJiraBaseUrl] = useState(null);
  const [actionsEnabled, setActionsEnabled] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [actionError, setActionError] = useState(null);
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
      setActionsEnabled(data.actionsEnabled === true);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs");
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {
      // Job history is supplementary — a failure here shouldn't blank the board.
    }
  }, []);

  const runAction = useCallback(
    async (key, action) => {
      setActionError(null);
      try {
        const res = await fetch(`/api/tickets/${key}/run-action`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const data = await res.json();
        if (!data.ok) {
          setActionError(data.error || "Failed to start command");
        }
      } catch (err) {
        setActionError(err.message);
      }
      await fetchJobs();
    },
    [fetchJobs],
  );

  useEffect(() => {
    fetchStacks();
    fetchJobs();

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
  }, [fetchStacks, fetchJobs]);

  // Refresh the board when a command finishes: it has just changed branches,
  // labels, and Jira state, so the current render is stale.
  const runningJobCount = jobs.filter((j) => j.status === "running").length;
  useEffect(() => {
    if (runningJobCount === 0 && jobs.length > 0) fetchStacks();
  }, [runningJobCount, jobs.length, fetchStacks]);

  const runningJobByTicket = new Map(
    jobs.filter((j) => j.status === "running").map((j) => [j.ticketKey, j]),
  );

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

      {actionError && <div className="action-error-banner">{actionError}</div>}

      <StagnationPanel stagnation={stagnation} jiraBaseUrl={jiraBaseUrl} />

      <JobsPanel jobs={jobs} onRefresh={fetchJobs} />

      {/* Outside the stacks.length check: an empty board is exactly when
          "what could I start?" matters most. */}
      <BacklogPanel jiraBaseUrl={jiraBaseUrl} />

      {stacks.length === 0 ? (
        <div className="empty">No active Claude tickets found.</div>
      ) : (
        <>
          <QueueView
            stacks={stacks}
            queues={queues}
            jiraBaseUrl={jiraBaseUrl}
            actionsEnabled={actionsEnabled}
            onRun={runAction}
            runningJobByTicket={runningJobByTicket}
          />
          <FeatureBranchStacks stacks={stacks} jiraBaseUrl={jiraBaseUrl} onAction={handleAction} />
          <StackOverview stacks={stacks} jiraBaseUrl={jiraBaseUrl} />
          <StackList
            stacks={stacks}
            onAction={handleAction}
            jiraBaseUrl={jiraBaseUrl}
            actionsEnabled={actionsEnabled}
            onRun={runAction}
            runningJobByTicket={runningJobByTicket}
          />
        </>
      )}

      {/* Ops hygiene sits last: it answers "what did the agents do?" and "what
          did they leave behind?", neither of which is a decision you make first. */}
      <TimelinePanel jiraBaseUrl={jiraBaseUrl} />
      <HygienePanel />
    </div>
  );
}
