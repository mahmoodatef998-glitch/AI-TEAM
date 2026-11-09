import { requireUser } from "@/lib/auth/session";
import { PageHeader } from "@/components/ui";
import { OfficeCanvas } from "./office-canvas";

export default async function OfficePage() {
  await requireUser();
  return (
    <div>
      <PageHeader
        title="Virtual office"
        subtitle="A live view of real agent activity: employees move to the room their current task belongs to, wait in the approval area when a human decision is needed, and return to their desk when done."
      />
      <OfficeCanvas />
    </div>
  );
}
