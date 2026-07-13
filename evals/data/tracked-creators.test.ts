import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  TrackedCreatorError,
  TrackedCreators,
  type TrackedCreatorAccount,
  type TrackedCreatorsRepository,
} from "@/lib/tracked-creators";

class MemoryRepository implements TrackedCreatorsRepository {
  readonly workspaceId: string;
  accounts = new Map<string, TrackedCreatorAccount>();
  memberships = new Map<string, string | null>();
  categories = new Map<
    string,
    { id: string; label: string; workspaceId: string | null }
  >();
  concurrentWinner: TrackedCreatorAccount | null = null;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  async countManualTracked() {
    return [...this.memberships.keys()].filter(
      (id) => this.accounts.get(id)?.source === "manual",
    ).length;
  }
  async findCategory(id: string) {
    return this.categories.get(id) ?? null;
  }
  async findAccountByUrl(profileUrl: string) {
    return (
      [...this.accounts.values()].find(
        (account) => account.profileUrl === profileUrl,
      ) ?? null
    );
  }
  async findAccountById(id: string) {
    return this.accounts.get(id) ?? null;
  }
  async findAccount(identifier: {
    id?: string;
    handle?: string;
    profileUrl?: string;
  }) {
    return (
      [...this.accounts.values()].find(
        (account) =>
          account.id === identifier.id ||
          account.linkedinHandle === identifier.handle?.toLowerCase() ||
          account.profileUrl === identifier.profileUrl,
      ) ?? null
    );
  }
  async isTracked(accountId: string) {
    return this.memberships.has(accountId);
  }
  async createAccount(input: Omit<TrackedCreatorAccount, "id">) {
    if (this.concurrentWinner) {
      const winner = this.concurrentWinner;
      this.accounts.set(winner.id, winner);
      this.concurrentWinner = null;
      return { account: winner, raced: true as const };
    }
    const account = { ...input, id: `account-${this.accounts.size + 1}` };
    this.accounts.set(account.id, account);
    return { account, raced: false as const };
  }
  async updateAccount(id: string, patch: Partial<TrackedCreatorAccount>) {
    const current = this.accounts.get(id);
    if (!current) return null;
    const updated = { ...current, ...patch };
    this.accounts.set(id, updated);
    return updated;
  }
  async track(accountId: string, niche: string | null) {
    this.memberships.set(accountId, niche);
  }
  async untrack(accountId: string) {
    return this.memberships.delete(accountId);
  }
  async updateWorkspaceNiche(accountId: string, niche: string | null) {
    if (!this.memberships.has(accountId)) return false;
    this.memberships.set(accountId, niche);
    return true;
  }
  async visibleCategoryIds(categoryIds: string[]) {
    return categoryIds.filter((id) => {
      const category = this.categories.get(id);
      return (
        category &&
        (category.workspaceId === null ||
          category.workspaceId === this.workspaceId)
      );
    });
  }
  async accountIdsByCategory(categoryIds: string[], includeArchived: boolean) {
    return [...this.accounts.values()]
      .filter(
        (item) =>
          item.categoryId &&
          categoryIds.includes(item.categoryId) &&
          (includeArchived || !item.archivedAt),
      )
      .map((item) => item.id);
  }
  async trackMany(accountIds: string[]) {
    for (const id of accountIds) this.memberships.set(id, null);
  }
  async untrackMany(accountIds: string[]) {
    for (const id of accountIds) this.memberships.delete(id);
  }
  async trackedAccountIds() {
    return [...this.memberships.keys()];
  }
  async list() {
    return [...this.memberships].map(([id, workspaceNiche]) => ({
      account: this.accounts.get(id)!,
      workspaceNiche,
      trackedAt: "2026-01-01T00:00:00.000Z",
    }));
  }
}

function account(
  overrides: Partial<TrackedCreatorAccount> = {},
): TrackedCreatorAccount {
  return {
    id: "account-1",
    name: "Creator",
    linkedinHandle: "creator",
    profileUrl: "https://www.linkedin.com/in/creator",
    niche: null,
    categoryId: null,
    profilePicUrl: null,
    source: "manual",
    archivedAt: null,
    manualOwnerWorkspaceId: "workspace-a",
    syncedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("TrackedCreators", () => {
  test("requires workspace identity at construction", () => {
    const repo = new MemoryRepository("");
    expect(() => new TrackedCreators(repo)).toThrow("workspace identity");
  });

  test("normalizes URLs and makes MCP-style adds idempotent", async () => {
    const repo = new MemoryRepository("workspace-a");
    const creators = new TrackedCreators(repo, {
      fetchProfileMeta: async () => ({ name: null, picUrl: null }),
    });

    const first = await creators.add({
      profileUrl: "linkedin.com/in/Creator/",
      name: "Creator",
      duplicate: "return_existing",
    });
    const second = await creators.add({
      profileUrl: "https://www.linkedin.com/in/creator?trk=x",
      name: "Creator",
      duplicate: "return_existing",
    });

    expect(first.account.id).toBe(second.account.id);
    expect(repo.accounts).toHaveLength(1);
    expect(repo.memberships.has(first.account.id)).toBe(true);
  });

  test("keeps the web duplicate response while centralizing the rule", async () => {
    const repo = new MemoryRepository("workspace-a");
    const existing = account();
    repo.accounts.set(existing.id, existing);
    repo.memberships.set(existing.id, null);
    const creators = new TrackedCreators(repo);

    await expect(
      creators.add({ profileUrl: existing.profileUrl, duplicate: "reject" }),
    ).rejects.toMatchObject({ code: "duplicate", status: 409 });
  });

  test("enforces the manual limit and foreign category isolation", async () => {
    const repo = new MemoryRepository("workspace-a");
    for (let index = 0; index < 50; index++) {
      const current = account({
        id: `account-${index}`,
        profileUrl: `https://www.linkedin.com/in/c${index}`,
      });
      repo.accounts.set(current.id, current);
      repo.memberships.set(current.id, null);
    }
    const creators = new TrackedCreators(repo);
    await expect(
      creators.add({ profileUrl: "linkedin.com/in/over-limit" }),
    ).rejects.toMatchObject({ code: "manual_limit", status: 409 });

    repo.memberships.clear();
    repo.categories.set("foreign", {
      id: "foreign",
      label: "Private",
      workspaceId: "workspace-b",
    });
    await expect(
      creators.add({
        profileUrl: "linkedin.com/in/new",
        categoryId: "foreign",
      }),
    ).rejects.toMatchObject({ code: "unknown_category", status: 400 });
  });

  test("an idempotent add still succeeds at capacity and clears MCP's omitted niche", async () => {
    const repo = new MemoryRepository("workspace-a");
    const existing = account();
    repo.accounts.set(existing.id, existing);
    repo.memberships.set(existing.id, "AI");
    for (let index = 1; index < 50; index++) {
      const current = account({
        id: `account-${index + 1}`,
        profileUrl: `https://www.linkedin.com/in/c${index}`,
      });
      repo.accounts.set(current.id, current);
      repo.memberships.set(current.id, null);
    }
    const creators = new TrackedCreators(repo);

    await creators.add({
      profileUrl: existing.profileUrl,
      duplicate: "return_existing",
      workspaceNiche: null,
    });

    expect(repo.memberships.get(existing.id)).toBeNull();
  });

  test("only the owning workspace can resurrect or edit a manual catalog row", async () => {
    const repo = new MemoryRepository("workspace-b");
    const archived = account({ archivedAt: "2026-01-02T00:00:00.000Z" });
    repo.accounts.set(archived.id, archived);
    const creators = new TrackedCreators(repo);

    await expect(
      creators.add({ profileUrl: archived.profileUrl }),
    ).rejects.toMatchObject({ code: "foreign_owner", status: 409 });

    repo.memberships.set(archived.id, null);
    await expect(
      creators.updateManual({ id: archived.id, name: "Changed" }),
    ).rejects.toMatchObject({ code: "foreign_owner", status: 409 });
  });

  test("recovers a concurrent catalog insert and tracks the winner", async () => {
    const repo = new MemoryRepository("workspace-a");
    repo.concurrentWinner = account({ id: "winner" });
    const creators = new TrackedCreators(repo);

    const result = await creators.add({
      profileUrl: "linkedin.com/in/creator",
      duplicate: "return_existing",
    });

    expect(result.account.id).toBe("winner");
    expect(repo.memberships.has("winner")).toBe(true);
  });

  test("a concurrent winner cannot receive another workspace's category write", async () => {
    const repo = new MemoryRepository("workspace-a");
    repo.categories.set("global", {
      id: "global",
      label: "AI",
      workspaceId: null,
    });
    repo.concurrentWinner = account({
      id: "winner",
      manualOwnerWorkspaceId: "workspace-b",
    });
    const creators = new TrackedCreators(repo);

    await expect(
      creators.add({
        profileUrl: "linkedin.com/in/creator",
        categoryId: "global",
      }),
    ).rejects.toMatchObject({ code: "foreign_owner", status: 409 });
    expect(repo.memberships.has("winner")).toBe(false);
  });

  test("a concurrent winner owned here is resurrected before it is tracked", async () => {
    const repo = new MemoryRepository("workspace-a");
    repo.concurrentWinner = account({
      id: "winner",
      archivedAt: "2026-01-02T00:00:00.000Z",
    });
    const creators = new TrackedCreators(repo);

    const result = await creators.add({
      profileUrl: "linkedin.com/in/creator",
    });

    expect(result.account.archivedAt).toBeNull();
    expect(repo.accounts.get("winner")?.archivedAt).toBeNull();
    expect(repo.memberships.has("winner")).toBe(true);
  });

  test("update, remove, restore, and list stay workspace-scoped", async () => {
    const repo = new MemoryRepository("workspace-a");
    const existing = account();
    repo.accounts.set(existing.id, existing);
    repo.memberships.set(existing.id, null);
    const creators = new TrackedCreators(repo);

    await creators.updateWorkspaceNiche({ id: existing.id, niche: "AI" });
    expect((await creators.list())[0].effectiveNiche).toBe("AI");
    await creators.remove({ id: existing.id });
    expect(await creators.list()).toEqual([]);
    await creators.restore({ id: existing.id });
    expect(await creators.list()).toHaveLength(1);
  });

  test("bulk category tracking ignores foreign categories", async () => {
    const repo = new MemoryRepository("workspace-a");
    repo.categories.set("visible", {
      id: "visible",
      label: "Visible",
      workspaceId: null,
    });
    repo.categories.set("foreign", {
      id: "foreign",
      label: "Foreign",
      workspaceId: "workspace-b",
    });
    const visible = account({ id: "visible-account", categoryId: "visible" });
    const foreign = account({ id: "foreign-account", categoryId: "foreign" });
    repo.accounts.set(visible.id, visible);
    repo.accounts.set(foreign.id, foreign);
    const creators = new TrackedCreators(repo);

    const affected = await creators.setCategoriesTracked({
      categoryIds: ["visible", "foreign"],
      tracked: true,
    });

    expect(affected).toBe(1);
    expect([...repo.memberships.keys()]).toEqual(["visible-account"]);
  });

  test("exposes typed product errors", () => {
    const error = new TrackedCreatorError(
      "not_found",
      "Account not found",
      404,
    );
    expect(error).toMatchObject({ code: "not_found", status: 404 });
  });

  test("web and MCP adapters delegate account policy to the same module", () => {
    const manualRoute = readFileSync(
      "app/api/accounts/manual/route.ts",
      "utf8",
    );
    const trackRoute = readFileSync("app/api/accounts/track/route.ts", "utf8");
    const categoryRoute = readFileSync(
      "app/api/accounts/by-category/route.ts",
      "utf8",
    );
    const accountsPage = readFileSync(
      "app/(app)/dashboard/accounts/page.tsx",
      "utf8",
    );
    const mcp = readFileSync("lib/mcp/register.ts", "utf8");
    const accountTools = mcp.slice(
      mcp.indexOf("// Read/write: workspace's tracked accounts"),
      mcp.indexOf("// Read/write: saved drafts"),
    );

    expect(manualRoute).toContain('from "@/lib/tracked-creators"');
    expect(trackRoute).toContain('from "@/lib/tracked-creators"');
    expect(categoryRoute).toContain('from "@/lib/tracked-creators"');
    expect(accountsPage).toContain("trackedCreators.trackedAccountIds()");
    expect(categoryRoute).not.toMatch(
      /\.from\(["'](?:accounts|workspace_accounts|categories)["']\)/,
    );
    expect(accountTools).toContain("trackedCreatorsForWorkspace");
    expect(accountTools).not.toMatch(
      /\.from\(["'](?:accounts|workspace_accounts)["']\)/,
    );
  });
});
