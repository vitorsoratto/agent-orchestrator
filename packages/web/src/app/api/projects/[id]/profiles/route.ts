import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function PATCH() {
  return NextResponse.json(
    { error: "Profile editing is not implemented yet. The default profile is managed automatically." },
    { status: 501 },
  );
}
