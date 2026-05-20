import { currentUser } from "@clerk/nextjs/server";

export class NotAdminError extends Error {
  constructor() {
    super("Admin only.");
    this.name = "NotAdminError";
  }
}

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export async function isAdmin(): Promise<boolean> {
  const allow = adminEmails();
  if (allow.length === 0) return false;
  const user = await currentUser();
  const email = user?.emailAddresses?.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress
    ?? user?.emailAddresses?.[0]?.emailAddress;
  if (!email) return false;
  return allow.includes(email.toLowerCase());
}

export async function requireAdmin(): Promise<void> {
  if (!(await isAdmin())) throw new NotAdminError();
}
