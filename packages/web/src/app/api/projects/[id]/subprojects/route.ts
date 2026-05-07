import { NextResponse, type NextRequest } from "next/server";
import {
  addCollectionSubproject,
  listCollectionSubprojects,
  loadConfig,
} from "@aoagents/ao-core";
import { revalidatePath } from "next/cache";
import { invalidatePortfolioServicesCache } from "@/lib/services";

export const dynamic = "force-dynamic";

function revalidateProject(projectId: string): void {
  for (const route of [`/projects/${projectId}`, `/projects/${projectId}/settings`]) {
    try {
      revalidatePath(route);
    } catch {
      // Tests do not always run in a full Next revalidation context.
    }
  }
}

function loadProject(projectId: string) {
  const config = loadConfig();
  const project = config.projects[projectId];
  if (!project) {
    return { error: NextResponse.json({ error: `Unknown project: ${projectId}` }, { status: 404 }) };
  }
  return { config, project };
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const loaded = loadProject(id);
    if (loaded.error) return loaded.error;

    return NextResponse.json(listCollectionSubprojects(id, loaded.project));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list subprojects" },
      { status: 400 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const rawPath = typeof body?.["path"] === "string" ? body["path"].trim() : "";
    if (!rawPath) {
      return NextResponse.json({ error: "Subproject path is required." }, { status: 400 });
    }

    const loaded = loadProject(id);
    if (loaded.error) return loaded.error;

    const subproject = addCollectionSubproject(id, loaded.project, rawPath);
    invalidatePortfolioServicesCache();
    revalidateProject(id);

    return NextResponse.json({ ok: true, subproject }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to add subproject" },
      { status: 400 },
    );
  }
}
