// The sliced-build ledger: read it, validate it, derive from it.
//
// `/build-sliced` and `/review-slices` both key every decision they make on the
// `Slice-Id` / `Depends-On` commit trailers. Before this module existed, both
// commands re-specified the same `git log --format` in prose, and the graph math
// on top of it — kind, depth, transitive closure, influence set, the `stable`
// predicate — was executed by an LLM reading a markdown table. That is the
// pattern `docs/design-notes.md` rejects for state: a shape that is a pure
// function of its inputs gets derived once, deterministically, not re-specified
// per caller.
//
// Every git invocation here is the one the commands used to carry in prose,
// including the non-obvious spellings that have silent failure modes:
//
//   - `separator=` on `%(trailers:…,valueonly)`. Without it git terminates each
//     value with a newline, so a line-oriented parse mis-splits every record.
//   - `--no-commit-id` before `git patch-id`. Without it the second output field
//     is the commit id rather than zeroes, and a caller taking the wrong field
//     gets a fingerprint that churns on every replay.
//   - `%P` alongside the trailers, so a merge commit is caught by parent count
//     rather than inferred from a missing trailer.

import { execSync } from "node:child_process";

// Record and field separators emitted by git itself (`%x01`, `%x00`) rather than
// embedded as raw control bytes in the shell argument.
const RECORD_SEP = "\x01";
const FIELD_SEP = "\x00";

const LEDGER_FORMAT =
  "%x01%H%x00%P%x00" +
  "%(trailers:key=Slice-Id,valueonly,separator=%x2C)%x00" +
  "%(trailers:key=Depends-On,valueonly,separator=%x2C)%x00%s";

function git(cmd, cwd) {
  return execSync(cmd, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitOrNull(cmd, cwd) {
  try {
    return git(cmd, cwd).trim();
  } catch {
    return null;
  }
}

function violation(code, message, extra = {}) {
  return { code, message, severity: "error", ...extra };
}

function warning(code, message, extra = {}) {
  return { code, message, severity: "warning", ...extra };
}

// The slice's content fingerprint: a patch-id, which hashes the change itself
// and is therefore independent of the parent commit and the committer timestamp.
// Every replayed slice gets a fresh SHA even when its content is untouched, so
// SHA cannot answer "did this slice's content actually change?" and patch-id can.
//
// Returns null when git emits no patch-id at all — an empty diff, or a
// metadata-only change with no hunks. Callers must treat a null fingerprint as
// never-stable: an unfingerprintable slice cannot be proven unchanged.
export function slicePatchId(sha, cwd) {
  const out = gitOrNull(
    `git diff-tree -p --no-commit-id ${sha} | git patch-id --stable`,
    cwd,
  );
  if (!out) return null;
  const id = out.split(/\s+/)[0];
  return id && /^[0-9a-f]{40,}$/.test(id) ? id : null;
}

export function sliceTouchedFiles(sha, cwd) {
  const out = gitOrNull(
    `git diff-tree --no-commit-id --name-only -r ${sha}`,
    cwd,
  );
  if (!out) return [];
  return out.split("\n").filter(Boolean);
}

function parseDependsOn(raw) {
  const parts = raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 1 && parts[0].toLowerCase() === "none") return [];
  return parts.filter((p) => p.toLowerCase() !== "none");
}

// Parse the raw `git log` payload into slices, in commit order (oldest first).
// Exported for tests and for callers that already hold the log output.
export function parseLedger(raw) {
  const slices = [];
  const records = String(raw || "")
    .split(RECORD_SEP)
    .map((r) => r.replace(/\n+$/, ""))
    .filter((r) => r.length > 0);

  for (const record of records) {
    const [sha = "", parents = "", id = "", dependsRaw = "", subject = ""] =
      record.split(FIELD_SEP);
    slices.push({
      sha: sha.trim(),
      parents: parents.trim().split(/\s+/).filter(Boolean),
      id: id.trim(),
      dependsOnRaw: dependsRaw.trim(),
      dependsOn: parseDependsOn(dependsRaw),
      subject: subject.trim(),
      index: slices.length,
    });
  }
  return slices;
}

// Every id that transitively reaches s through `Depends-On` — the set s builds
// on. `byId` maps id -> slice. Assumes the edge set is acyclic; callers run
// validation first.
function closureOf(slice, byId, cache) {
  const cached = cache.get(slice.id);
  if (cached) return cached;

  const acc = new Set();
  // Seed the cache before recursing so a cycle that slipped past validation
  // terminates instead of blowing the stack.
  cache.set(slice.id, acc);
  for (const depId of slice.dependsOn) {
    acc.add(depId);
    const dep = byId.get(depId);
    if (!dep) continue;
    for (const id of closureOf(dep, byId, cache)) acc.add(id);
  }
  return acc;
}

function detectCycles(slices, byId) {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map(slices.map((s) => [s.id, WHITE]));
  const cycles = [];

  const walk = (slice, path) => {
    color.set(slice.id, GREY);
    for (const depId of slice.dependsOn) {
      // A self-edge is already reported on its own; re-reporting it as a cycle
      // is noise on top of the same defect.
      if (depId === slice.id) continue;
      const dep = byId.get(depId);
      if (!dep) continue;
      const state = color.get(dep.id);
      if (state === GREY) {
        const start = path.indexOf(dep.id);
        cycles.push([...path.slice(start >= 0 ? start : 0), dep.id]);
        continue;
      }
      if (state === WHITE) walk(dep, [...path, dep.id]);
    }
    color.set(slice.id, BLACK);
  };

  for (const slice of slices) {
    if (color.get(slice.id) === WHITE) walk(slice, [slice.id]);
  }
  return cycles;
}

// Validate the ledger. Every check here is a case where deriving anyway would
// produce plausible-looking wrong output rather than an error.
function validate(slices) {
  const violations = [];
  const byId = new Map();

  for (const slice of slices) {
    if (slice.parents.length > 1) {
      violations.push(
        violation(
          "merge-commit",
          `${slice.sha.slice(0, 8)} is a merge commit ("${slice.subject}"). ` +
            "A merge carries no Slice-Id, so it owns lines no finding can be " +
            "routed to. Rebase onto the moved base instead of merging it in.",
          { sha: slice.sha },
        ),
      );
      continue;
    }

    if (!slice.id) {
      // An empty `Slice-Id` with a populated `Depends-On` is the signature of
      // the multi-`-m` mis-commit: git parses only the last paragraph of the
      // message as trailers, so the earlier `-m` never becomes one.
      const splitTrailers = slice.dependsOnRaw.length > 0;
      violations.push(
        violation(
          splitTrailers ? "empty-slice-id" : "missing-slice-id",
          splitTrailers
            ? `${slice.sha.slice(0, 8)} has an empty Slice-Id but a parsed ` +
                "Depends-On — the trailers were split across separate -m flags. " +
                "Both must land in one -m, newline-separated."
            : `${slice.sha.slice(0, 8)} carries no Slice-Id trailer ` +
                `("${slice.subject}"). One commit per slice is a ledger invariant.`,
          { sha: slice.sha },
        ),
      );
      continue;
    }

    if (byId.has(slice.id)) {
      violations.push(
        violation(
          "duplicate-slice-id",
          `Slice-Id ${slice.id} appears on more than one commit ` +
            `(${byId.get(slice.id).sha.slice(0, 8)}, ${slice.sha.slice(0, 8)}). ` +
            "A slice is exactly one commit.",
          { id: slice.id, sha: slice.sha },
        ),
      );
      continue;
    }

    byId.set(slice.id, slice);
  }

  // Edge checks only make sense once every id is known.
  for (const slice of byId.values()) {
    if (slice.dependsOnRaw.length === 0) {
      violations.push(
        violation(
          "missing-depends-on",
          `${slice.id} carries no Depends-On trailer. A root slice must say ` +
            "`Depends-On: none` explicitly — an absent field is indistinguishable " +
            "from a mis-committed trailer block.",
          { id: slice.id, sha: slice.sha },
        ),
      );
    }

    for (const depId of slice.dependsOn) {
      if (depId === slice.id) {
        violations.push(
          violation("self-edge", `${slice.id} lists itself in Depends-On.`, {
            id: slice.id,
          }),
        );
        continue;
      }

      const dep = byId.get(depId);
      if (!dep) {
        violations.push(
          violation(
            "dangling-edge",
            `${slice.id} depends on ${depId}, which names no slice in range — ` +
              "a typo, or a dependency below BASE. Replay scope, depth, and the " +
              "stable predicate all derive from these edges.",
            { id: slice.id, dependsOn: depId },
          ),
        );
        continue;
      }

      // The graph must agree with commit order. Replay rewinds positionally and
      // re-applies in commit order, so a slice whose dependency is committed
      // *later* was never actually built against it: the closure and the replay
      // would disagree, silently. Acyclicity alone does not catch this.
      if (dep.index > slice.index) {
        violations.push(
          violation(
            "forward-edge",
            `${slice.id} depends on ${depId}, which is committed after it. ` +
              "Replay is positional, so a dependency must always be an earlier " +
              "commit. Reorder the slices (rebase) rather than editing the edge.",
            { id: slice.id, dependsOn: depId },
          ),
        );
      }
    }
  }

  for (const cycle of detectCycles([...byId.values()], byId)) {
    violations.push(
      violation(
        "cycle",
        `Cycle in the Depends-On edges: ${cycle.join(" -> ")}. ` +
          "Depth has no base case on a cycle, so nothing downstream can derive.",
        { cycle },
      ),
    );
  }

  return { violations, byId };
}

// Kind is binary and answers "does anything build on this?". Depth is the
// slice's level in the graph. They are different axes: in s01 <- s02 <- s03 both
// s01 and s02 are foundations, but their depths are 0 and 1. Neither is declared
// in a trailer, because a trailer would have to be written on a claim about
// slices that do not exist yet.
function derive(slices, byId) {
  const dependedUpon = new Set();
  for (const slice of byId.values()) {
    for (const depId of slice.dependsOn) dependedUpon.add(depId);
  }

  const depthCache = new Map();
  const depthOf = (slice, seen = new Set()) => {
    if (depthCache.has(slice.id)) return depthCache.get(slice.id);
    if (seen.has(slice.id)) return 0;
    seen.add(slice.id);

    let depth = 0;
    for (const depId of slice.dependsOn) {
      const dep = byId.get(depId);
      if (!dep) continue;
      depth = Math.max(depth, depthOf(dep, seen) + 1);
    }
    depthCache.set(slice.id, depth);
    return depth;
  };

  for (const slice of slices) {
    if (!slice.id || !byId.has(slice.id)) continue;
    slice.kind = dependedUpon.has(slice.id) ? "foundation" : "leaf";
    slice.depth = depthOf(slice);
  }
}

// How far origin/<base> has advanced past the stack. This loop is long-lived by
// design — build, review, replay, repeat — so the base moving underneath it is
// the expected case. Reads existing refs only; the caller decides whether to
// fetch first.
export function baseDrift({ base, head = "HEAD", cwd }) {
  const remote = `origin/${base}`;
  if (gitOrNull(`git rev-parse --verify -q ${remote}^{commit}`, cwd) === null) {
    return { checked: false, advanced: false, behindBy: null, remote };
  }

  let advanced = false;
  try {
    git(`git merge-base --is-ancestor ${remote} ${head}`, cwd);
  } catch {
    advanced = true;
  }

  const count = gitOrNull(`git rev-list --count ${head}..${remote}`, cwd);
  const behindBy = count === null ? null : Number.parseInt(count, 10);

  return {
    checked: true,
    advanced,
    behindBy: Number.isNaN(behindBy) ? null : behindBy,
    remote,
  };
}

// Read, validate, and derive in one pass. Fingerprints (patch-id + touched
// files) cost one or two git calls per slice, so they are opt-out for callers
// that only need the graph.
export function readLedger({
  base,
  head = "HEAD",
  cwd,
  fingerprints = true,
  drift = false,
}) {
  if (!base) throw new Error("readLedger: base is required");
  if (!cwd) throw new Error("readLedger: cwd is required");

  let raw;
  try {
    raw = git(
      `git log --reverse --no-decorate ${base}..${head} --format='${LEDGER_FORMAT}'`,
      cwd,
    );
  } catch (err) {
    throw new Error(
      `cannot read ${base}..${head}: ${String(err.stderr || err.message).trim()}`,
    );
  }

  const slices = parseLedger(raw);
  const { violations, byId } = validate(slices);
  const readable = violations.length === 0;

  if (readable) {
    derive(slices, byId);
    if (fingerprints) {
      for (const slice of slices) {
        slice.patchId = slicePatchId(slice.sha, cwd);
        slice.touched = sliceTouchedFiles(slice.sha, cwd);
        if (!slice.patchId) {
          violations.push(
            warning(
              "unfingerprintable-slice",
              `${slice.id} produced no patch-id (empty or metadata-only diff). ` +
                "It can never be proven unchanged, so it will always be treated " +
                "as changed and will always run its bar.",
              { id: slice.id, sha: slice.sha },
            ),
          );
        }
      }
    }
  }

  const errors = violations.filter((v) => v.severity === "error");

  return {
    base,
    head,
    ok: errors.length === 0,
    readable,
    slices: readable ? slices : [],
    unreadable: readable ? [] : slices,
    counts: {
      slices: readable ? slices.length : 0,
      foundation: slices.filter((s) => s.kind === "foundation").length,
      leaf: slices.filter((s) => s.kind === "leaf").length,
      maxDepth: slices.reduce((m, s) => Math.max(m, s.depth ?? 0), 0),
    },
    violations,
    drift: drift ? baseDrift({ base, head, cwd }) : null,
  };
}

// The influence set: the slices that can break s, which is strictly larger than
// the set s builds on.
//
// Replay rewinds positionally (`git reset --hard parent(START)`, then re-apply in
// commit order), so the tree s is rebuilt against is BASE plus *every* slice
// committed before it — of which the Depends-On closure is a subset, usually a
// proper one. An earlier slice s declares no edge to can still break it: two
// leaves writing the same barrel file, a shared test fixture, migration
// ordering. `Depends-On` cannot close this, because its author is answering
// "what do I import?", not "who could invalidate my tests?".
//
// So widen the closure by the one such coupling git can see: a shared file.
// Overlap is computed over the *union* of each slice's before and after file
// lists, because a slice that stops touching a file is exactly as dangerous as
// one that starts. A replay that moves slice t's content out of `a.ts` leaves no
// overlap at measure time, and a downstream slice reading `a.ts` would look
// stable while the file it depends on lost its content.
//
// `prior` maps id -> { patchId, touched } as recorded when the stack was last
// measured. Absent means "no prior record"; the union degrades to the current
// list.
export function influenceSets(slices, prior = {}) {
  const byId = new Map(slices.filter((s) => s.id).map((s) => [s.id, s]));
  const closureCache = new Map();

  const filesOf = (slice) => {
    const files = new Set(slice.touched || []);
    for (const f of prior[slice.id]?.touched || []) files.add(f);
    return files;
  };
  const fileSets = new Map(slices.map((s) => [s.id, filesOf(s)]));

  const result = new Map();
  for (const slice of slices) {
    const influences = new Set(closureOf(slice, byId, closureCache));
    const own = fileSets.get(slice.id);
    for (const earlier of slices) {
      if (earlier.index >= slice.index) break;
      const theirs = fileSets.get(earlier.id);
      for (const f of theirs) {
        if (own.has(f)) {
          influences.add(earlier.id);
          break;
        }
      }
    }
    influences.delete(slice.id);
    result.set(slice.id, influences);
  }
  return result;
}

// stable(s) = s's own patch-id unchanged AND every patch-id in its influence set
// unchanged. This is the predicate that decides whether a slice is re-reviewed
// and whether its bar runs, and it is the best skip git can justify — not a
// proof. A coupling through a third file, with neither a declared edge nor a
// shared path, is invisible to it.
//
// `absentMeans` resolves the one place the two callers legitimately differ:
//
//   - /review-slices measures every slice in the ledger against the previous
//     review's record. A slice absent from that record is new, hence changed.
//   - /build-sliced measures only slices at or after the replay start. The
//     rewind does not reach anything earlier, so an influence-set member that
//     predates START contributes "unchanged" without being measured.
export function computeStability({
  slices,
  prior = {},
  absentMeans = "changed",
}) {
  const influences = influenceSets(slices, prior);
  const absentIsChanged = absentMeans === "changed";
  const byId = new Map(slices.map((s) => [s.id, s]));

  const moved = (id) => {
    const slice = byId.get(id);
    const before = prior[id];
    if (!before) return absentIsChanged;
    // An unfingerprintable slice can never be proven unchanged.
    if (!slice?.patchId || !before.patchId) return true;
    return slice.patchId !== before.patchId;
  };

  const results = new Map();
  for (const slice of slices) {
    const ownMoved = moved(slice.id);
    const movedInfluences = [...influences.get(slice.id)].filter(moved).sort();
    results.set(slice.id, {
      id: slice.id,
      depth: slice.depth ?? 0,
      kind: slice.kind ?? null,
      stable: !ownMoved && movedInfluences.length === 0,
      ownMoved,
      movedInfluences,
      influences: [...influences.get(slice.id)].sort(),
    });
  }
  return results;
}

// The four replay classes. The distinction between the last two is the entire
// reason the influence set exists: `context-changed` is the case a patch-id-only
// comparison silently files as `regenerated-identical` — the slice reads the same
// and behaves differently.
//
// `regenerated-identical` is the only class that skips the bar.
export function classifySlice({ stability, hadFinding }) {
  if (stability.ownMoved) return hadFinding ? "changed" : "shape-changed";
  if (stability.movedInfluences.length > 0) return "context-changed";
  return "regenerated-identical";
}

export const RUNS_BAR = new Set([
  "changed",
  "shape-changed",
  "context-changed",
]);

// Review scope: every slice that is not stable, in commit order, plus the union
// of the files those slices touch. Commit order is load-bearing — the caller
// records this list and later needs its *first* element as a replay anchor, so an
// unordered set would leave "earliest" undefined.
export function computeScope({ slices, prior = {}, absentMeans = "changed" }) {
  const stability = computeStability({ slices, prior, absentMeans });

  const changed = [];
  const stable = [];
  for (const slice of slices) {
    const entry = stability.get(slice.id);
    (entry.stable ? stable : changed).push(slice.id);
  }

  const inScope = new Set(changed);
  const files = new Set();
  for (const slice of slices) {
    if (!inScope.has(slice.id)) continue;
    for (const f of slice.touched || []) files.add(f);
  }

  const earliest = slices.find((s) => inScope.has(s.id)) || null;
  const contiguous = earliest
    ? slices.slice(earliest.index).every((s) => inScope.has(s.id))
    : true;

  return {
    changed,
    stable,
    earliest: earliest?.id ?? null,
    // The diff range for the review fan-out. Contiguous scope is the normal
    // case; when it is not, this over-covers, which is tolerated because every
    // finding is resolved back to its own Slice-Id afterwards.
    range: earliest ? `${earliest.sha}~1...${slices.at(-1).sha}` : null,
    contiguous,
    files: [...files].sort(),
    detail: [...stability.values()],
  };
}

// A record of every slice's measured state, for the next run to compare against.
export function snapshot(slices) {
  const map = {};
  for (const slice of slices) {
    if (!slice.id) continue;
    map[slice.id] = {
      patchId: slice.patchId ?? null,
      touched: [...(slice.touched || [])].sort(),
    };
  }
  return map;
}

// Resolve a finding's `file:line` to the slice whose commit last touched that
// line. Three outcomes, and they are not the same finding:
//
//   - an id            -> the slice that owns the line
//   - { preBase: sha } -> the line's last change predates BASE, so this is about
//                         code the branch never touched. Drop it; no replay can
//                         reach it.
//   - null             -> a seam no single commit owns, or a path absent from
//                         HEAD. Unassigned.
//
// `-s` is required: `-L` implies `-p`, so without it the id arrives with a full
// diff hunk stapled to it. A path that does not exist at HEAD makes git fail
// with exit 128 rather than return empty, which is why that is caught, not
// treated as a signal.
export function resolveFindingSlice({ file, line, base, head = "HEAD", cwd }) {
  const range = `${base}..${head}`;
  const loc = `-L${line},${line}:${file}`;

  const inRange = gitOrNull(
    `git log ${range} -1 -s --format='%(trailers:key=Slice-Id,valueonly,separator=%x2C)' ${loc}`,
    cwd,
  );
  if (inRange === null) return { sliceId: null, reason: "no-such-path" };
  if (inRange)
    return { sliceId: inRange.split(",")[0].trim(), reason: "owned" };

  // Empty in-range output has two causes. Ask for the owning commit over full
  // history — a pre-BASE commit carries no Slice-Id, so asking for the trailer
  // again would come back empty in both cases and distinguish nothing.
  const owner = gitOrNull(`git log -1 -s --format='%H' ${loc}`, cwd);
  if (!owner) return { sliceId: null, reason: "unowned" };

  let preBase = false;
  try {
    git(`git merge-base --is-ancestor ${owner} ${base}`, cwd);
    preBase = true;
  } catch {
    preBase = false;
  }

  return { sliceId: null, reason: preBase ? "pre-base" : "unowned", owner };
}
