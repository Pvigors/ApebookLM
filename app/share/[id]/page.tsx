import PublicNotebook from "@/components/PublicNotebook";

export const dynamic = "force-dynamic";

export default async function SharePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <PublicNotebook id={id} />;
}
