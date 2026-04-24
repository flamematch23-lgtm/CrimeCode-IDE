import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import z from "zod"
import { ProjectID } from "../../project/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { InstanceBootstrap } from "../../project/bootstrap"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

/**
 * Base directory where auto-created projects are placed.
 * Override with OPENCODE_PROJECTS_ROOT (useful in hosted / sandboxed setups).
 */
function projectsRoot(): string {
  return process.env["OPENCODE_PROJECTS_ROOT"] ?? path.join(homedir(), "opencode-projects")
}

function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
  return cleaned || "untitled"
}

function stampSlug(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = Project.list()
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        const prev = Instance.project
        const next = await Project.initGit({
          directory: dir,
          project: prev,
        })
        if (next.id === prev.id && next.vcs === prev.vcs && next.worktree === prev.worktree) return c.json(next)
        await Instance.reload({
          directory: dir,
          worktree: dir,
          project: next,
          init: InstanceBootstrap,
        })
        return c.json(next)
      },
    )
    .post(
      "/create",
      describeRoute({
        summary: "Create new project folder",
        description:
          "Create an empty project workspace on disk under OPENCODE_PROJECTS_ROOT (default ~/opencode-projects). " +
          "Folder name is `{YYYYMMDDHHMMSS}-{slug(name)}` so repeated creates never collide. Returns the absolute " +
          "directory so the client can navigate straight into it.",
        operationId: "project.createFolder",
        responses: {
          200: {
            description: "Directory created",
            content: {
              "application/json": {
                schema: resolver(z.object({ directory: z.string() })),
              },
            },
          },
          ...errors(400, 500),
        },
      }),
      validator(
        "json",
        z
          .object({
            name: z.string().trim().max(64).optional(),
          })
          .optional(),
      ),
      async (c) => {
        const body = c.req.valid("json") ?? {}
        const slug = slugify(body.name ?? "untitled")
        const dir = path.join(projectsRoot(), `${stampSlug()}-${slug}`)
        try {
          await mkdir(dir, { recursive: true })
        } catch (err) {
          return c.json(
            { error: `Could not create directory: ${err instanceof Error ? err.message : String(err)}` },
            500,
          )
        }
        return c.json({ directory: dir })
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UpdateInput.omit({ projectID: true })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const body = c.req.valid("json")
        const project = await Project.update({ ...body, projectID })
        return c.json(project)
      },
    ),
)
