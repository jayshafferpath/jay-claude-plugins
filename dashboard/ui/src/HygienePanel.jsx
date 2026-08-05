// Worktrees left on disk that no active ticket claims.
//
// The lifecycle creates a worktree per ticket and /cleanup removes it. Anything
// that skipped cleanup leaves one behind, and until now nothing in the dashboard
// showed them — so they pile up until someone notices the disk.
//
// On demand: this costs a `git worktree list` per repo, and stale worktrees
// accumulate over days, not seconds.

import { useCallback, useEffect, useState } from "react";
import { fetchPanel } from "./fetchPanel.js";

export function HygienePanel() {
  const [hygiene, setHygiene] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showAll, setShowAll] = useState(false);

  const fetchHygiene = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHygiene(await fetchPanel("/api/hygiene"));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHygiene();
  }, [fetchHygiene]);

  const repos = hygiene?.repos || [];
  const orphanedTotal = hygiene?.counts?.orphaned || 0;

  // Clean repos are hidden by default — the panel exists to flag problems, and
  // a row per healthy repo is noise. "show all" reveals them.
  const visibleRepos = showAll
    ? repos
    : repos.filter((r) => r.counts.orphaned > 0);

  return (
    <div className="hygiene-panel">
      <h2 className="section-title">
        Worktrees
        {orphanedTotal > 0 && (
          <span className="hygiene-count">{orphanedTotal} orphaned</span>
        )}
        <button
          type="button"
          className="backlog-refresh"
          onClick={fetchHygiene}
          disabled={loading}
        >
          {loading ? "checking..." : "refresh"}
        </button>
        {repos.length > 0 && (
          <button
            type="button"
            className="backlog-refresh"
            onClick={() => setShowAll(!showAll)}
          >
            {showAll ? "only problems" : "show all"}
          </button>
        )}
      </h2>

      {error && <div className="backlog-error">{error}</div>}

      {hygiene && orphanedTotal === 0 && !showAll && !error && (
        <div className="backlog-empty">
          No orphaned worktrees across {repos.length} repo
          {repos.length === 1 ? "" : "s"}.
        </div>
      )}

      {visibleRepos.map((repo) => (
        <div className="hygiene-repo" key={repo.repoRoot}>
          <div className="hygiene-repo-head">
            <span className="hygiene-repo-name">{repo.name}</span>
            <span className="hygiene-repo-counts">
              {repo.counts.active} active
              {repo.counts.orphaned > 0 && `, ${repo.counts.orphaned} orphaned`}
              {repo.counts.unknown > 0 && `, ${repo.counts.unknown} unknown`}
            </span>
          </div>
          {repo.worktrees
            .filter((wt) => showAll || wt.status === "orphaned")
            .map((wt) => (
              <div
                className={`hygiene-item hygiene-item--${wt.status}`}
                key={wt.path}
              >
                <span className={`hygiene-status hygiene-status--${wt.status}`}>
                  {wt.status}
                </span>
                <span className="hygiene-path">{wt.path}</span>
                {wt.branch && (
                  <span className="hygiene-branch">{wt.branch}</span>
                )}
                {/* The command is shown rather than run: removing a worktree can
                    discard uncommitted work, so this stays a human decision. */}
                {wt.status === "orphaned" && (
                  <code className="hygiene-command">
                    git worktree remove {wt.path}
                  </code>
                )}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}
