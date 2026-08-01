import type { Metadata } from "next";
import { SignUp } from "@clerk/nextjs";

export const metadata: Metadata = {
  title: "Create your SwipeIn account",
  description: "Start your SwipeIn trial and build a proven LinkedIn content workflow.",
};

export default function SignUpPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <SignUp />
    </div>
  );
}
