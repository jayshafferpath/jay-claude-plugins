import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJiraAuth, loadDevRoot } from "../lib/config.js";

describe("loadDevRoot", () => {
  const orig = process.env.DEV_ROOT;

  afterEach(() => {
    if (orig === undefined) delete process.env.DEV_ROOT;
    else process.env.DEV_ROOT = orig;
  });

  it("returns DEV_ROOT when set", () => {
    process.env.DEV_ROOT = "/some/path";
    expect(loadDevRoot()).toBe("/some/path");
  });

  it("returns null when unset", () => {
    delete process.env.DEV_ROOT;
    expect(loadDevRoot()).toBeNull();
  });
});

describe("getJiraAuth", () => {
  const keys = [
    "JIRA_EMAIL",
    "JIRA_API_TOKEN",
    "JIRA_DOMAIN",
    "ATLASSIAN_EMAIL",
    "ATLASSIAN_API_TOKEN",
    "ATLASSIAN_DOMAIN",
  ];
  const saved = {};

  beforeEach(() => {
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("returns credentials from JIRA_ vars", () => {
    process.env.JIRA_EMAIL = "a@b.com";
    process.env.JIRA_API_TOKEN = "tok";
    process.env.JIRA_DOMAIN = "x.atlassian.net";
    expect(getJiraAuth()).toEqual({
      email: "a@b.com",
      token: "tok",
      domain: "x.atlassian.net",
    });
  });

  it("falls back to ATLASSIAN_ vars", () => {
    process.env.ATLASSIAN_EMAIL = "c@d.com";
    process.env.ATLASSIAN_API_TOKEN = "tok2";
    process.env.ATLASSIAN_DOMAIN = "y.atlassian.net";
    expect(getJiraAuth()).toEqual({
      email: "c@d.com",
      token: "tok2",
      domain: "y.atlassian.net",
    });
  });

  it("returns null when credentials are incomplete", () => {
    process.env.JIRA_EMAIL = "a@b.com";
    expect(getJiraAuth()).toBeNull();
  });
});
