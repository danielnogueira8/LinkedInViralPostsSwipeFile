import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  errorResponse: vi.fn(() =>
    Response.json({ ok: false, error: "internal" }, { status: 500 }),
  ),
  auth: vi.fn(async () => ({ userId: "user-1" })),
  scopedSupabase: vi.fn(async () => ({ workspaceId: "workspace-1", raw: {} })),
  createBrandResource: vi.fn(),
  createCategoryResource: vi.fn(),
  purgeWorkspaceData: vi.fn(),
}));

vi.mock("@/lib/workspace", () => ({
  errorResponse: mocks.errorResponse,
  requireWorkspaceId: vi.fn(async () => "workspace-1"),
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
  currentUser: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase-scoped", () => ({
  scopedSupabase: mocks.scopedSupabase,
  trackedAccountIds: vi.fn(async () => []),
}));
vi.mock("@/lib/content-resource-operations", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/content-resource-operations")>();
  return {
    ...original,
    createBrandResource: mocks.createBrandResource,
    createCategoryResource: mocks.createCategoryResource,
  };
});
vi.mock("@/lib/purge-workspace", () => ({
  purgeWorkspaceData: mocks.purgeWorkspaceData,
}));
vi.mock("@/lib/tracked-creators", () => ({
  TrackedCreatorError: class TrackedCreatorError extends Error {},
  TrackedCreators: class TrackedCreators {},
}));
vi.mock("@/lib/tracked-creators-supabase", () => ({
  createSupabaseTrackedCreatorsRepository: vi.fn(),
  createWorkspaceAccountWriter: vi.fn(),
}));
vi.mock("@/lib/linkedin-url", () => ({
  displayNameFromHandle: (handle: string) => handle,
  fetchProfileMeta: vi.fn(),
}));
vi.mock("@/lib/linkedin-embed-scrape", () => ({
  fetchEmbedCard: vi.fn(),
}));
vi.mock("@/lib/templates-builtin", () => ({
  getBuiltinTemplate: vi.fn(() => null),
}));
vi.mock("@/lib/agent/untrusted", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agent/untrusted")>();
  return {
    ...original,
    neutralizeMarkers: (value: string) => value,
  };
});
vi.mock("@/lib/shared-bookmarks", () => ({
  resolveActiveLibrary: vi.fn(),
  SharedBookmarkAccessError: class SharedBookmarkAccessError extends Error {},
}));

const { POST: addManual } = await import("@/app/api/accounts/manual/route");
const { POST: createBrand } = await import("@/app/api/branding/route");
const { POST: createCategory } = await import("@/app/api/categories/route");
const { POST: createModelSource } = await import("@/app/api/model-source/route");
const { PATCH: patchShare } = await import("@/app/api/shared-bookmarks/[id]/route");
const { POST: deleteAccount } = await import("@/app/api/account/delete/route");

function request(body: string): Request {
  return new Request("https://app.tryswipein.com/api/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("general API routes reject malformed request bodies at the route seam", () => {
  test.each([
    ["manual account", () => addManual(request("{"))],
    ["branding", () => createBrand(request("{"))],
    ["category", () => createCategory(request("{"))],
    ["model source", () => createModelSource(request("{"))],
    ["shared bookmark transition", () => patchShare(request("{"), { params: Promise.resolve({ id: "share-1" }) })],
  ])("%s returns 400 rather than an internal-error response", async (_label, invoke) => {
    const response = await invoke();
    expect(response.status).toBe(400);
    expect((await response.json()).ok).toBe(false);
    expect(mocks.errorResponse).not.toHaveBeenCalled();
    mocks.errorResponse.mockClear();
  });

  test("account deletion treats a JSON null body as a missing confirmation", async () => {
    const response = await deleteAccount(request("null"));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/confirmation required/i);
    expect(mocks.purgeWorkspaceData).not.toHaveBeenCalled();
    expect(mocks.errorResponse).not.toHaveBeenCalled();
  });
});
