import {
  isManualAccountLimitError,
  MANUAL_ACCOUNT_LIMIT,
  MANUAL_ACCOUNT_LIMIT_MESSAGE,
} from "@/lib/account-tracking";

export type TrackedCreatorAccount = {
  id: string;
  name: string;
  linkedinHandle: string;
  profileUrl: string;
  niche: string | null;
  categoryId: string | null;
  profilePicUrl: string | null;
  source: string;
  archivedAt: string | null;
  manualOwnerWorkspaceId: string | null;
  syncedAt: string;
};

export type TrackedCreatorCategory = {
  id: string;
  label: string;
  workspaceId: string | null;
};

export type TrackedCreatorIdentifier = {
  id?: string;
  handle?: string;
  profileUrl?: string;
};

export type TrackedCreatorListRow = {
  account: TrackedCreatorAccount;
  workspaceNiche: string | null;
  trackedAt: string;
};

export type TrackedCreatorsRepository = {
  readonly workspaceId: string;
  countManualTracked(): Promise<number>;
  findCategory(id: string): Promise<TrackedCreatorCategory | null>;
  findAccountByUrl(profileUrl: string): Promise<TrackedCreatorAccount | null>;
  findAccountById(id: string): Promise<TrackedCreatorAccount | null>;
  findAccount(
    identifier: TrackedCreatorIdentifier,
  ): Promise<TrackedCreatorAccount | null>;
  isTracked(accountId: string): Promise<boolean>;
  createAccount(
    input: Omit<TrackedCreatorAccount, "id">,
  ): Promise<{ account: TrackedCreatorAccount; raced: boolean }>;
  updateAccount(
    id: string,
    patch: Partial<TrackedCreatorAccount>,
  ): Promise<TrackedCreatorAccount | null>;
  track(accountId: string, niche: string | null): Promise<void>;
  untrack(accountId: string): Promise<boolean>;
  updateWorkspaceNiche(
    accountId: string,
    niche: string | null,
  ): Promise<boolean>;
  visibleCategoryIds(categoryIds: string[]): Promise<string[]>;
  accountIdsByCategory(
    categoryIds: string[],
    includeArchived: boolean,
  ): Promise<string[]>;
  trackMany(accountIds: string[]): Promise<void>;
  untrackMany(accountIds: string[]): Promise<void>;
  trackedAccountIds(): Promise<string[]>;
  list(input?: {
    niche?: string;
    search?: string;
    includeArchived?: boolean;
    limit?: number;
  }): Promise<TrackedCreatorListRow[]>;
};

export type TrackedCreatorErrorCode =
  | "invalid_url"
  | "invalid_identifier"
  | "manual_limit"
  | "unknown_category"
  | "duplicate"
  | "foreign_owner"
  | "not_found"
  | "not_manual"
  | "nothing_to_update";

export class TrackedCreatorError extends Error {
  constructor(
    readonly code: TrackedCreatorErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TrackedCreatorError";
  }
}

export function normalizeLinkedInProfileUrl(raw: string): string | null {
  const match = raw.trim().match(/linkedin\.com\/in\/([^/\?#]+)/i);
  if (!match) return null;
  return `https://www.linkedin.com/in/${match[1].toLowerCase()}`;
}

function handleFromProfileUrl(profileUrl: string): string {
  return profileUrl.split("/in/")[1] ?? "creator";
}

function displayNameFromHandle(handle: string): string {
  return handle
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizedIdentifier(
  identifier: TrackedCreatorIdentifier,
): TrackedCreatorIdentifier {
  const values = [
    identifier.id,
    identifier.handle,
    identifier.profileUrl,
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  if (values.length !== 1) {
    throw new TrackedCreatorError(
      "invalid_identifier",
      "Provide exactly one of: id, linkedin_handle, profile_url.",
      400,
    );
  }
  if (identifier.profileUrl) {
    const profileUrl = normalizeLinkedInProfileUrl(identifier.profileUrl);
    if (!profileUrl) {
      throw new TrackedCreatorError(
        "invalid_url",
        "Invalid LinkedIn profile URL.",
        400,
      );
    }
    return { profileUrl };
  }
  if (identifier.handle)
    return { handle: identifier.handle.trim().toLowerCase() };
  return { id: identifier.id!.trim() };
}

export class TrackedCreators {
  private readonly fetchProfileMeta: (
    profileUrl: string,
  ) => Promise<{ name: string | null; picUrl: string | null }>;
  private readonly nameFromHandle: (handle: string) => string;

  constructor(
    private readonly repository: TrackedCreatorsRepository,
    dependencies: {
      fetchProfileMeta?: (
        profileUrl: string,
      ) => Promise<{ name: string | null; picUrl: string | null }>;
      displayNameFromHandle?: (handle: string) => string;
    } = {},
  ) {
    if (!repository.workspaceId.trim()) {
      throw new Error("TrackedCreators requires workspace identity.");
    }
    this.fetchProfileMeta =
      dependencies.fetchProfileMeta ??
      (async () => ({ name: null, picUrl: null }));
    this.nameFromHandle =
      dependencies.displayNameFromHandle ?? displayNameFromHandle;
  }

  private isGlobalBaseline(account: TrackedCreatorAccount): boolean {
    return account.source !== "manual" && account.manualOwnerWorkspaceId === null;
  }

  private isAvailableToWorkspace(account: TrackedCreatorAccount): boolean {
    return (
      this.isGlobalBaseline(account) ||
      (account.source === "manual" &&
        account.manualOwnerWorkspaceId === this.repository.workspaceId)
    );
  }

  private async prepareExistingAccount(
    account: TrackedCreatorAccount,
    input: {
      category: TrackedCreatorCategory | null;
      categoryRequested: boolean;
      profilePicUrl: string | null;
      syncedAt: string;
    },
  ): Promise<TrackedCreatorAccount> {
    const isOwner =
      account.manualOwnerWorkspaceId === this.repository.workspaceId;
    if (input.categoryRequested && !isOwner) {
      throw new TrackedCreatorError(
        "foreign_owner",
        "This creator is shared from another workspace. Add it without changing its global category.",
        409,
      );
    }
    if (account.archivedAt && !isOwner) {
      throw new TrackedCreatorError(
        "foreign_owner",
        "This creator was archived by its original workspace and can't be restored here.",
        409,
      );
    }

    const patch: Partial<TrackedCreatorAccount> = {};
    if (account.archivedAt) {
      patch.archivedAt = null;
      patch.syncedAt = input.syncedAt;
    }
    if (input.category && !account.categoryId) {
      patch.categoryId = input.category.id;
      patch.niche = input.category.label;
    }
    if (input.profilePicUrl && !account.profilePicUrl && isOwner) {
      patch.profilePicUrl = input.profilePicUrl;
    }
    if (Object.keys(patch).length === 0) return account;
    return (await this.repository.updateAccount(account.id, patch)) ?? account;
  }

  async list(input?: Parameters<TrackedCreatorsRepository["list"]>[0]) {
    const rows = await this.repository.list(input);
    return rows.map(({ account, workspaceNiche, trackedAt }) => ({
      ...account,
      workspaceNiche,
      effectiveNiche: workspaceNiche ?? account.niche,
      trackedAt,
    }));
  }

  async add(input: {
    profileUrl: string;
    name?: string;
    categoryId?: string | null;
    workspaceNiche?: string | null;
    duplicate?: "reject" | "return_existing";
    resolveProfileMeta?: boolean;
  }) {
    const profileUrl = normalizeLinkedInProfileUrl(input.profileUrl);
    if (!profileUrl) {
      throw new TrackedCreatorError(
        "invalid_url",
        "Invalid LinkedIn profile URL",
        400,
      );
    }
    const categoryId = input.categoryId?.trim() || null;
    let category: TrackedCreatorCategory | null = null;
    if (categoryId) {
      category = await this.repository.findCategory(categoryId);
      if (
        !category ||
        (category.workspaceId !== null &&
          category.workspaceId !== this.repository.workspaceId)
      ) {
        throw new TrackedCreatorError(
          "unknown_category",
          `Unknown category: ${categoryId}`,
          400,
        );
      }
    }

    let account = await this.repository.findAccountByUrl(profileUrl);
    const alreadyTracked = account
      ? await this.repository.isTracked(account.id)
      : false;
    if (account && !account.archivedAt && alreadyTracked) {
      if ((input.duplicate ?? "reject") === "reject") {
        throw new TrackedCreatorError(
          "duplicate",
          "You're already tracking this creator.",
          409,
        );
      }
      if (input.workspaceNiche !== undefined) {
        await this.repository.updateWorkspaceNiche(
          account.id,
          input.workspaceNiche?.trim() || null,
        );
      }
      return { account, created: false, metaResolved: false };
    }
    const needsManualSlot = !account || account.source === "manual";
    if (
      needsManualSlot &&
      (await this.repository.countManualTracked()) >= MANUAL_ACCOUNT_LIMIT
    ) {
      throw new TrackedCreatorError(
        "manual_limit",
        MANUAL_ACCOUNT_LIMIT_MESSAGE,
        409,
      );
    }
    const handle = handleFromProfileUrl(profileUrl);
    const meta =
      input.resolveProfileMeta === false
        ? { name: null, picUrl: null }
        : await this.fetchProfileMeta(profileUrl);
    const name =
      input.name?.trim() || meta.name || this.nameFromHandle(handle) || handle;
    const now = new Date().toISOString();
    let created = false;

    if (account) {
      account = await this.prepareExistingAccount(account, {
        category,
        categoryRequested: Boolean(categoryId),
        profilePicUrl: meta.picUrl,
        syncedAt: now,
      });
    } else {
      const result = await this.repository.createAccount({
        name,
        linkedinHandle: handle,
        profileUrl,
        niche: category?.label ?? input.workspaceNiche?.trim() ?? null,
        categoryId: category?.id ?? null,
        profilePicUrl: meta.picUrl,
        source: "manual",
        archivedAt: null,
        manualOwnerWorkspaceId: this.repository.workspaceId,
        syncedAt: now,
      });
      account = result.account;
      created = !result.raced;
      if (result.raced) {
        account = await this.prepareExistingAccount(account, {
          category,
          categoryRequested: Boolean(categoryId),
          profilePicUrl: meta.picUrl,
          syncedAt: now,
        });
      }
    }

    try {
      await this.repository.track(
        account.id,
        input.workspaceNiche?.trim() || null,
      );
    } catch (error) {
      if (isManualAccountLimitError(error)) {
        throw new TrackedCreatorError(
          "manual_limit",
          MANUAL_ACCOUNT_LIMIT_MESSAGE,
          409,
        );
      }
      throw error;
    }
    return {
      account,
      created,
      metaResolved: Boolean(meta.name || meta.picUrl),
    };
  }

  async trackExisting(accountId: string) {
    const account = await this.repository.findAccountById(accountId);
    if (
      !account ||
      account.archivedAt ||
      !this.isAvailableToWorkspace(account)
    ) {
      throw new TrackedCreatorError("not_found", "Account not found", 404);
    }
    try {
      await this.repository.track(account.id, null);
    } catch (error) {
      if (isManualAccountLimitError(error)) {
        throw new TrackedCreatorError(
          "manual_limit",
          MANUAL_ACCOUNT_LIMIT_MESSAGE,
          409,
        );
      }
      throw error;
    }
    return account;
  }

  async untrack(accountId: string) {
    await this.repository.untrack(accountId);
  }

  trackedAccountIds() {
    return this.repository.trackedAccountIds();
  }

  async setAccountsTracked(input: {
    accountIds: string[];
    tracked: boolean;
    globalBaselineOnly?: boolean;
  }) {
    const accountIds = [...new Set(input.accountIds)];
    if (accountIds.length === 0) return 0;

    // Untracking arbitrary ids is a workspace-scoped delete and is therefore
    // both safe and idempotent. Skip catalog reads so a large "Pause visible"
    // action does not fan out into one account query per row.
    if (!input.tracked && !input.globalBaselineOnly) {
      await this.repository.untrackMany(accountIds);
      return accountIds.length;
    }

    const accounts = await Promise.all(
      accountIds.map((accountId) => this.repository.findAccountById(accountId)),
    );
    const unavailable = accounts.some((account) => {
      if (!account || account.archivedAt) return true;
      return input.globalBaselineOnly
        ? !this.isGlobalBaseline(account)
        : !this.isAvailableToWorkspace(account);
    });
    if (unavailable) {
      throw new TrackedCreatorError(
        "not_found",
        "One or more creators are not available to this workspace.",
        404,
      );
    }

    try {
      if (input.tracked) await this.repository.trackMany(accountIds);
      else await this.repository.untrackMany(accountIds);
    } catch (error) {
      if (isManualAccountLimitError(error)) {
        throw new TrackedCreatorError(
          "manual_limit",
          MANUAL_ACCOUNT_LIMIT_MESSAGE,
          409,
        );
      }
      throw error;
    }
    return accountIds.length;
  }

  async setCategoriesTracked(input: {
    categoryIds: string[];
    tracked: boolean;
  }) {
    const categoryIds = await this.repository.visibleCategoryIds([
      ...new Set(input.categoryIds),
    ]);
    if (categoryIds.length === 0) return 0;
    const accountIds = await this.repository.accountIdsByCategory(
      categoryIds,
      !input.tracked,
    );
    if (accountIds.length === 0) return 0;
    try {
      if (input.tracked) await this.repository.trackMany(accountIds);
      else await this.repository.untrackMany(accountIds);
    } catch (error) {
      if (isManualAccountLimitError(error)) {
        throw new TrackedCreatorError(
          "manual_limit",
          MANUAL_ACCOUNT_LIMIT_MESSAGE,
          409,
        );
      }
      throw error;
    }
    return accountIds.length;
  }

  async updateManual(input: {
    id: string;
    name?: string;
    categoryId?: string | null;
  }) {
    if (!(await this.repository.isTracked(input.id))) {
      throw new TrackedCreatorError("not_found", "Account not found", 404);
    }
    const account = await this.repository.findAccountById(input.id);
    if (!account) {
      throw new TrackedCreatorError("not_found", "Account not found", 404);
    }
    if (account.source !== "manual") {
      throw new TrackedCreatorError(
        "not_manual",
        "Only manually-added creators can be edited.",
        400,
      );
    }
    if (account.manualOwnerWorkspaceId !== this.repository.workspaceId) {
      throw new TrackedCreatorError(
        "foreign_owner",
        "This shared creator can only be edited by its original workspace.",
        409,
      );
    }
    const patch: Partial<TrackedCreatorAccount> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) {
        throw new TrackedCreatorError(
          "nothing_to_update",
          "Name can't be empty",
          400,
        );
      }
      patch.name = name;
    }
    if (input.categoryId !== undefined) {
      const categoryId = input.categoryId?.trim() || null;
      if (!categoryId) {
        patch.categoryId = null;
        patch.niche = null;
      } else {
        const category = await this.repository.findCategory(categoryId);
        if (
          !category ||
          (category.workspaceId !== null &&
            category.workspaceId !== this.repository.workspaceId)
        ) {
          throw new TrackedCreatorError(
            "unknown_category",
            `Unknown category: ${categoryId}`,
            400,
          );
        }
        patch.categoryId = category.id;
        patch.niche = category.label;
      }
    }
    if (Object.keys(patch).length === 0) {
      throw new TrackedCreatorError(
        "nothing_to_update",
        "Nothing to update",
        400,
      );
    }
    const updated = await this.repository.updateAccount(account.id, patch);
    if (!updated)
      throw new TrackedCreatorError("not_found", "Account not found", 404);
    return updated;
  }

  async updateWorkspaceNiche(
    input: TrackedCreatorIdentifier & { niche: string | null },
  ) {
    const account = await this.resolve(input);
    const niche = input.niche?.trim() || null;
    if (!(await this.repository.updateWorkspaceNiche(account.id, niche))) {
      throw new TrackedCreatorError(
        "not_found",
        "Account isn't tracked by this workspace. Use add_account first.",
        404,
      );
    }
    return {
      account,
      workspaceNiche: niche,
      effectiveNiche: niche ?? account.niche,
    };
  }

  async remove(identifier: TrackedCreatorIdentifier, manualOnly = false) {
    let account: TrackedCreatorAccount | null;
    if (manualOnly && identifier.id) {
      if (!(await this.repository.isTracked(identifier.id))) {
        throw new TrackedCreatorError("not_found", "Account not found", 404);
      }
      account = await this.repository.findAccountById(identifier.id);
      if (!account) {
        throw new TrackedCreatorError("not_found", "Account not found", 404);
      }
    } else {
      account = await this.resolve(identifier);
    }
    if (!(await this.repository.isTracked(account.id))) {
      throw new TrackedCreatorError(
        "not_found",
        "Account wasn't tracked by this workspace.",
        404,
      );
    }
    if (manualOnly && account.source !== "manual") {
      throw new TrackedCreatorError(
        "not_manual",
        "Only manually-added creators can be deleted. Untrack this one instead.",
        400,
      );
    }
    await this.repository.untrack(account.id);
    return account;
  }

  async restore(identifier: TrackedCreatorIdentifier) {
    let account = await this.resolve(identifier);
    if (account.archivedAt) {
      if (account.manualOwnerWorkspaceId !== this.repository.workspaceId) {
        throw new TrackedCreatorError(
          "foreign_owner",
          "This creator was archived by its original workspace and can't be restored here.",
          409,
        );
      }
      account =
        (await this.repository.updateAccount(account.id, {
          archivedAt: null,
          syncedAt: new Date().toISOString(),
        })) ?? account;
    }
    try {
      await this.repository.track(account.id, null);
    } catch (error) {
      if (isManualAccountLimitError(error)) {
        throw new TrackedCreatorError(
          "manual_limit",
          MANUAL_ACCOUNT_LIMIT_MESSAGE,
          409,
        );
      }
      throw error;
    }
    return account;
  }

  private async resolve(identifier: TrackedCreatorIdentifier) {
    const normalized = normalizedIdentifier(identifier);
    const account = await this.repository.findAccount(normalized);
    if (!account) {
      throw new TrackedCreatorError(
        "not_found",
        "No matching account found.",
        404,
      );
    }
    return account;
  }
}
