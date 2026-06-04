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
});
