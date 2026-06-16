import { notFound } from "next/navigation";
import AdminPanel from "@/components/AdminPanel";
import { adminRouteSecret, isAdminAuthenticated } from "@/lib/auth";
import { readSiteConfig, toAdminPayload } from "@/lib/config";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Painel Dragon Store"
};

type SecretAdminPageProps = {
  params: Promise<{ adminSecret: string }>;
};

export default async function SecretAdminPage({ params }: SecretAdminPageProps) {
  const { adminSecret } = await params;
  if (adminSecret !== adminRouteSecret()) notFound();

  const loggedIn = await isAdminAuthenticated();
  const initialConfig = loggedIn ? toAdminPayload(await readSiteConfig()) : null;

  return <AdminPanel loggedIn={loggedIn} initialConfig={initialConfig} />;
}
