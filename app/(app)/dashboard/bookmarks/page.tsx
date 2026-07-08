import { redirect } from "next/navigation";

type BookmarksRedirectSearchParams = {
  category?: string;
  share?: string;
  sort?: string;
  type?: string;
};

export default async function BookmarksPage({
  searchParams,
}: {
  searchParams: Promise<BookmarksRedirectSearchParams>;
}) {
  const sp = await searchParams;
  const params = new URLSearchParams({ tab: "bookmarks" });
  if (sp.category) params.set("category", sp.category);
  if (sp.share) params.set("share", sp.share);
  if (sp.sort) params.set("sort", sp.sort);
  if (sp.type) params.set("type", sp.type);
  redirect(`/dashboard/swipe?${params.toString()}`);
}
