import { NextResponse, type NextRequest } from "next/server";
import {
  loadConfig,
  removeCollectionSubproject,
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

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ id: string; repoKey: string }> },
) {
  try {
    const { id, repoKey } = await context.params;
    const config = loadConfig();
    const project = config.projects[id];
    if (!project) {
      return NextResponse.json({ error: `Unknown project: ${id}` }, { status: 404 });
    }

    removeCollectionSubproject(id, project, repoKey);
    invalidatePortfolioServicesCache();
    revalidateProject(id);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to remove subproject" },
      { status: 400 },
    );
  }
}
