import { LoadingState } from "@/components/ui/loading-state";

export default function PublicLeadMagnetLoading() {
  return (
    <div className="flex min-h-[50vh] items-center justify-center px-6">
      <LoadingState label="Loading resource" />
    </div>
  );
}
