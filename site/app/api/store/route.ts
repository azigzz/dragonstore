import { NextResponse } from "next/server";
import { getStoreData } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await getStoreData();
  return NextResponse.json(store, {
    headers: {
      "Cache-Control": "no-store"
    }
  });
}
