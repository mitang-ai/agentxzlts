import { adminIdentity } from "@/lib/control";
import { AppError } from "@/lib/server";
import AdminDashboard from "@/components/AdminDashboard";
import AdminLogin from "@/components/AdminLogin";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  const module = section?.[0] || "overview";
  try {
    const user = await adminIdentity(module);
    return <AdminDashboard user={user} section={module} />;
  } catch (e) {
    if (e instanceof AppError)
      return <AdminLogin message={e.status === 401 ? "" : e.message} />;
    throw e;
  }
}
