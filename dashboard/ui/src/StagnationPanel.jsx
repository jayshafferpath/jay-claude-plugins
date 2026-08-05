// Time-based stalls, from cli/lib/stagnation.js.
//
// This is the one panel that shows something no amount of label-reading can:
// a ClaudeExecuting label asserts an agent is running *right now*, and only a
// timestamp can tell you the claim is stale. Findings arrive pre-sorted
// worst-first with a suggestedAction each, so this component just renders.

const KIND_LABELS = {
  "abandoned-in-flight": "Abandoned mid-run",
  "unattended-failure": "Unattended failure",
  "rotting-pr": "Rotting PR",
};

// The command a human should run to clear each finding. The lib emits an
// action slug; this maps it to something copy-pasteable.
const ACTION_COMMANDS = {
  "clear-stale-in-flight": "/orchestrate",
  "escalate-failure": "/fix-drift or /rework",
  "stack-rebase": "/stack-rebase",
  "ping-review": "ping a reviewer",
};

export function StagnationPanel({ stagnation, jiraBaseUrl }) {
  const findings = stagnation?.findings || [];
  if (!findings.length) return null;

  return (
    <div className="stagnation-panel">
      <h2 className="section-title">
        Stalled
        <span className="stagnation-count">{findings.length}</span>
      </h2>
      <div className="stagnation-list">
        {findings.map((finding, i) => (
          <div
            key={`${finding.key}-${finding.kind}-${i}`}
            className={`stagnation-item stagnation-item--${finding.kind}`}
          >
            <div className="stagnation-item-main">
              {jiraBaseUrl ? (
                <a
                  href={`${jiraBaseUrl}/${finding.key}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="stagnation-key"
                >
                  {finding.key}
                </a>
              ) : (
                <span className="stagnation-key">{finding.key}</span>
              )}
              <span className="stagnation-kind">
                {KIND_LABELS[finding.kind] || finding.kind}
              </span>
              {finding.prUrl && (
                <a
                  href={finding.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="stagnation-pr"
                >
                  #{finding.prNumber}
                </a>
              )}
            </div>
            <div className="stagnation-detail">{finding.detail}</div>
            {finding.suggestedAction && (
              <div className="stagnation-action">
                →{" "}
                {ACTION_COMMANDS[finding.suggestedAction] ||
                  finding.suggestedAction}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
