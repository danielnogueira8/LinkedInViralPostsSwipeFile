import { redirect } from "next/navigation";

// The Drafts page was renamed to Posts and moved to /dashboard/posts. Keep this
// stub so any existing bookmark / deep link to the old path lands in the right
// place instead of 404ing. Safe to delete once no traffic hits /dashboard/drafts.
export default function DraftsRedirect() {
  redirect("/dashboard/posts");
}
