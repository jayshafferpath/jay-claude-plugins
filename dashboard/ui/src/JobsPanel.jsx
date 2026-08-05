// Commands the dashboard has launched, and what they printed.
//
// A headless `claude -p` run takes minutes and can fail halfway. Without this
// panel a launched command is a black box: you'd click Run, watch the labels not
// change, and have no idea whether it was still working or had died.
//
// Jobs are in-memory server-side, so this list resets when the API restarts.
// That's fine — the durable record is the Jira activity log the commands write.

import { useEffect, useState } from "react";

const STATUS_GLYPH = {
  running: "◌",
  succeeded: "✓",
  failed: "✗",
};

export function JobsPanel({ jobs, onRefresh }) {
  const [openId, setOpenId] = useState(null);
  const [log, setLog] = useState(null);

  const hasRunning = jobs.some((j) => j.status === "running");

  // Poll faster than the main dashboard while something is in flight: a command
  // mid-run is the one thing here that changes second to second.
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(onRefresh, 3000);
    return () => clearInterval(interval);
  }, [hasRunning, onRefresh]);

  // Keep the open log fresh while its own job is still running.
  useEffect(() => {
    if (!openId) return;

    let cancelled = false;
    const fetchLog = async () => {
      try {
        const res = await fetch(`/api/jobs/${openId}`);
        const data = await res.json();
        if (!cancelled && data.ok) setLog(data.job);
      } catch {
        // Transient fetch failure; the next tick retries.
      }
    };

    fetchLog();
    const job = jobs.find((j) => j.id === openId);
    if (job?.status !== "running") return () => { cancelled = true; };

    const interval = setInterval(fetchLog, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [openId, jobs]);

  if (!jobs.length) return null;

  return (
    <div className="jobs-panel">
      <h2 className="section-title">
        Commands
        {hasRunning && <span className="jobs-running-count">running</span>}
      </h2>
      <div className="jobs-list">
        {jobs.map((job) => {
          const isOpen = openId === job.id;
          return (
            <div className={`job job--${job.status}`} key={job.id}>
              <div
                role="button"
                tabIndex={0}
                className="job-head"
                onClick={() => {
                  setLog(null);
                  setOpenId(isOpen ? null : job.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setLog(null);
                    setOpenId(isOpen ? null : job.id);
                  }
                }}
              >
                <span className={`job-status job-status--${job.status}`}>
                  {STATUS_GLYPH[job.status] || "?"}
                </span>
                <code className="job-prompt">{job.prompt}</code>
                <span className="job-time">
                  {new Date(job.startedAt).toLocaleTimeString()}
                </span>
                {job.exitCode !== null && job.exitCode !== 0 && (
                  <span className="job-exit">exit {job.exitCode}</span>
                )}
              </div>
              {job.error && <div className="job-error">{job.error}</div>}
              {isOpen && (
                <pre className="job-log">
                  {log?.log || "(no output yet)"}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
