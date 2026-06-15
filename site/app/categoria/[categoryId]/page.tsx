import { notFound } from "next/navigation";
import CategoryStorefront from "@/components/CategoryStorefront";
import { readSiteConfig } from "@/lib/config";
import { getStoreData } from "@/lib/store";

export const dynamic = "force-dynamic";

type CategoryPageProps = {
  params: Promise<{ categoryId: string }>;
};

export default async function CategoryPage({ params }: CategoryPageProps) {
  const [{ categoryId }, store, config] = await Promise.all([params, getStoreData(), readSiteConfig()]);
  const category = store.categories?.find(item => item.id === categoryId);

  if (!category) notFound();

  return <CategoryStorefront store={store} config={config} category={category} />;
}
