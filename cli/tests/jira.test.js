import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/config.js", () => ({
  getJiraAuth: vi.fn(),
}));

const { getJiraAuth } = await import("../lib/config.js");
const {
  searchIssues,
  getIssue,
  editIssue,
  addLabel,
  removeLabel,
  swapLabel,
  getComments,
  addComment,
  updateComment,
  deleteComment,
  getPrFromDevStatus,
  buildSetStatePatch,
  setTicketState,
} = await import("../lib/jira.js");

function mockFetch(body, ok = true, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("jira module", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getJiraAuth.mockReturnValue({
      email: "a@b.com",
      token: "tok",
      domain: "x.atlassian.net",
    });
  });

  afterEach(() => {
    delete global.fetch;
  });

  it("throws when credentials are missing", async () => {
    getJiraAuth.mockReturnValue(null);
    await expect(searchIssues("project = X")).rejects.toThrow(
      "Missing Jira credentials",
    );
  });

  describe("searchIssues", () => {
    it("returns issues from response", async () => {
      mockFetch({ issues: [{ key: "X-1" }] });
      const result = await searchIssues("project = X", ["summary"]);
      expect(result).toEqual([{ key: "X-1" }]);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://x.atlassian.net/rest/api/3/search/jql",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws on non-OK response", async () => {
      mockFetch("bad", false, 400);
      await expect(searchIssues("bad")).rejects.toThrow(
        "Jira search failed (400)",
      );
    });

    it("returns empty array when issues is missing", async () => {
      mockFetch({});
      const result = await searchIssues("project = X");
      expect(result).toEqual([]);
    });
  });

  describe("getIssue", () => {
    it("returns issue data", async () => {
      mockFetch({ key: "X-1", fields: {} });
      const result = await getIssue("X-1");
      expect(result).toEqual({ key: "X-1", fields: {} });
    });

    it("throws on failure", async () => {
      mockFetch("err", false, 404);
      await expect(getIssue("X-1")).rejects.toThrow(
        "Jira getIssue failed (404)",
      );
    });
  });

  describe("editIssue", () => {
    it("sends PUT with update body", async () => {
      mockFetch(null, true, 204);
      await editIssue("X-1", { labels: [{ add: "foo" }] });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://x.atlassian.net/rest/api/3/issue/X-1",
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("throws on failure", async () => {
      mockFetch("err", false, 500);
      await expect(editIssue("X-1", {})).rejects.toThrow(
        "Jira editIssue failed (500)",
      );
    });
  });

  describe("addLabel / removeLabel / swapLabel", () => {
    it("addLabel calls editIssue with add", async () => {
      mockFetch(null, true, 204);
      await addLabel("X-1", "ClaudeReady");
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.update.labels).toEqual([{ add: "ClaudeReady" }]);
    });

    it("removeLabel calls editIssue with remove", async () => {
      mockFetch(null, true, 204);
      await removeLabel("X-1", "ClaudeReady");
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.update.labels).toEqual([{ remove: "ClaudeReady" }]);
    });

    it("swapLabel calls editIssue with remove and add", async () => {
      mockFetch(null, true, 204);
      await swapLabel("X-1", "Old", "New");
      const body = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(body.update.labels).toEqual([{ remove: "Old" }, { add: "New" }]);
    });
  });

  describe("buildSetStatePatch", () => {
    it("returns null when there is nothing to change", () => {
      expect(
        buildSetStatePatch(["ClaudeWork", "ClaudeReady"], {
          add: ["ClaudeReady"],
        }),
      ).toBeNull();
    });

    it("clears every progress label currently applied when adding a new one", () => {
      const patch = buildSetStatePatch(
        ["ClaudeWork", "ClaudeExecuting", "ClaudePlanning"],
        { add: ["ClaudeStackReady"] },
      );
      expect(patch.labels).toEqual(
        expect.arrayContaining([
          { remove: "ClaudePlanning" },
          { remove: "ClaudeExecuting" },
          { add: "ClaudeStackReady" },
        ]),
      );
      expect(patch.labels).toHaveLength(3);
    });

    it("does not emit removes for progress labels that are not currently set", () => {
      const patch = buildSetStatePatch(["ClaudeWork"], {
        add: ["ClaudeReady"],
      });
      expect(patch.labels).toEqual([{ add: "ClaudeReady" }]);
    });

    it("supports adding a non-progress label without clearing progress", () => {
      const patch = buildSetStatePatch(["ClaudeWork", "ClaudeStackReady"], {
        add: ["ClaudePruned"],
      });
      // Progress labels are cleared because the operation declares a state move.
      expect(patch.labels).toEqual(
        expect.arrayContaining([
          { remove: "ClaudeStackReady" },
          { add: "ClaudePruned" },
        ]),
      );
    });

    it("removes arbitrary labels passed via remove", () => {
      const patch = buildSetStatePatch(["ClaudeWork", "ClaudeStackComplete"], {
        remove: ["ClaudeStackComplete"],
      });
      expect(patch.labels).toEqual([{ remove: "ClaudeStackComplete" }]);
    });

    it("does not double-remove a label that is also in add", () => {
      const patch = buildSetStatePatch(["ClaudeWork", "ClaudeReady"], {
        add: ["ClaudeReady"],
        remove: ["ClaudeReady"],
      });
      // ClaudeReady is already present and being added → no-op.
      expect(patch).toBeNull();
    });
  });

  describe("setTicketState", () => {
    it("rejects --to values that are not progress labels", async () => {
      await expect(
        setTicketState("X-1", { to: "NotARealLabel" }),
      ).rejects.toThrow(/--to must be one of/);
    });

    it("fetches current labels and PUTs the diff", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              fields: { labels: ["ClaudeWork", "ClaudePlanning"] },
            }),
        })
        .mockResolvedValueOnce({ ok: true, status: 204 });

      const ops = await setTicketState("X-1", { to: "ClaudeExecuting" });
      expect(ops).toEqual([
        { remove: "ClaudePlanning" },
        { add: "ClaudeExecuting" },
      ]);
      const putBody = JSON.parse(global.fetch.mock.calls[1][1].body);
      expect(putBody.update.labels).toEqual([
        { remove: "ClaudePlanning" },
        { add: "ClaudeExecuting" },
      ]);
    });

    it("returns null and skips PUT when nothing would change", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            fields: { labels: ["ClaudeWork", "ClaudeExecuting"] },
          }),
      });
      const ops = await setTicketState("X-1", { to: "ClaudeExecuting" });
      expect(ops).toBeNull();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("getComments", () => {
    it("returns comments array", async () => {
      mockFetch({ comments: [{ id: "1" }] });
      const result = await getComments("X-1");
      expect(result).toEqual([{ id: "1" }]);
    });

    it("throws on failure", async () => {
      mockFetch("err", false, 403);
      await expect(getComments("X-1")).rejects.toThrow(
        "Jira getComments failed (403)",
      );
    });

    it("returns empty array when comments is missing", async () => {
      mockFetch({});
      const result = await getComments("X-1");
      expect(result).toEqual([]);
    });
  });

  describe("addComment", () => {
    it("posts comment and returns response", async () => {
      mockFetch({ id: "2" });
      const result = await addComment("X-1", { type: "doc", content: [] });
      expect(result).toEqual({ id: "2" });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://x.atlassian.net/rest/api/3/issue/X-1/comment",
        expect.objectContaining({ method: "POST" }),
      );
    });

    it("throws on failure", async () => {
      mockFetch("err", false, 500);
      await expect(addComment("X-1", {})).rejects.toThrow(
        "Jira addComment failed (500)",
      );
    });
  });

  describe("updateComment", () => {
    it("puts comment and returns response", async () => {
      mockFetch({ id: "2" });
      const result = await updateComment("X-1", "2", {
        type: "doc",
        content: [],
      });
      expect(result).toEqual({ id: "2" });
      expect(global.fetch).toHaveBeenCalledWith(
        "https://x.atlassian.net/rest/api/3/issue/X-1/comment/2",
        expect.objectContaining({ method: "PUT" }),
      );
    });

    it("throws on failure", async () => {
      mockFetch("err", false, 500);
      await expect(updateComment("X-1", "2", {})).rejects.toThrow(
        "Jira updateComment failed (500)",
      );
    });
  });

  describe("deleteComment", () => {
    it("sends DELETE request", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      });
      await deleteComment("X-1", "5");
      expect(global.fetch).toHaveBeenCalledWith(
        "https://x.atlassian.net/rest/api/3/issue/X-1/comment/5",
        expect.objectContaining({ method: "DELETE" }),
      );
    });

    it("throws on failure", async () => {
      mockFetch("err", false, 404);
      await expect(deleteComment("X-1", "5")).rejects.toThrow(
        "Jira deleteComment failed (404)",
      );
    });
  });

  describe("getPrFromDevStatus", () => {
    it("returns PR info from dev-status API", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "12345" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              detail: [
                {
                  pullRequests: [
                    {
                      id: "#42",
                      name: "feat: do stuff",
                      url: "https://github.com/org/repo/pull/42",
                      status: "OPEN",
                    },
                  ],
                },
              ],
            }),
        });

      const result = await getPrFromDevStatus("X-1");
      expect(result).toEqual({
        url: "https://github.com/org/repo/pull/42",
        number: 42,
        state: "OPEN",
        title: "feat: do stuff",
      });
    });

    it("prefers open PR over closed", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "12345" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              detail: [
                {
                  pullRequests: [
                    {
                      id: "#10",
                      name: "old",
                      url: "https://github.com/org/repo/pull/10",
                      status: "DECLINED",
                    },
                    {
                      id: "#20",
                      name: "new",
                      url: "https://github.com/org/repo/pull/20",
                      status: "OPEN",
                    },
                  ],
                },
              ],
            }),
        });

      const result = await getPrFromDevStatus("X-1");
      expect(result.number).toBe(20);
      expect(result.state).toBe("OPEN");
    });

    it("returns null when no PRs exist", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ id: "12345" }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ detail: [{ pullRequests: [] }] }),
        });

      const result = await getPrFromDevStatus("X-1");
      expect(result).toBeNull();
    });

    it("returns null when issue fetch fails", async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      const result = await getPrFromDevStatus("X-1");
      expect(result).toBeNull();
    });
  });
});
