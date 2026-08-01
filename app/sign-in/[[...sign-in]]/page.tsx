import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Sign in · SwipeIn",
  description: "Sign in to your SwipeIn workspace.",
};

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <SignIn />
    </div>
  );
}
