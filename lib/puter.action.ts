import puter from "@heyputer/puter.js";
import { getOrCreateHostingConfig, uploadImageToHosting } from "./puter.hosting";
import { isHostedUrl } from "./utils";
import { PUTER_WORKER_URL } from "./constants";

const LOCAL_PROJECTS_KEY = "floorplan.projects";

const readLocalProjects = (): DesignItem[] => {
    if (typeof window === "undefined" || !window.localStorage) return [];

    try {
        const raw = window.localStorage.getItem(LOCAL_PROJECTS_KEY);
        if (!raw) return [];

        const parsed = JSON.parse(raw) as DesignItem[];
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const saveLocalProjects = (projects: DesignItem[]) => {
    if (typeof window === "undefined" || !window.localStorage) return;

    try {
        window.localStorage.setItem(LOCAL_PROJECTS_KEY, JSON.stringify(projects));
    } catch {
        // Ignore storage errors in fallback mode.
    }
};

const upsertLocalProject = (project: DesignItem) => {
    const projects = readLocalProjects();
    const index = projects.findIndex((p) => p.id === project.id);

    if (index >= 0) {
        projects[index] = project;
    } else {
        projects.unshift(project);
    }

    saveLocalProjects(projects);
};

export const signIn = async () => await puter.auth.signIn();

export const signOut = () => puter.auth.signOut();

export const getCurrentUser = async () => {
    try {
        return await puter.auth.getUser();
    } catch (error) {
        return null;
    }
};

export const createProject = async ({
    item,
    visibility = "private",
}: CreateProjectParams): Promise<DesignItem | null | undefined> => {
    const projectId = item.id;

    // When running without a configured worker URL, fall back to a
    // purely client‑side implementation using localStorage.
    if (!PUTER_WORKER_URL) {
        console.warn("Missing VITE_PUTER_WORKER_URL; using local storage fallback.");
        const localProject: DesignItem = {
            ...item,
            id: projectId,
        };
        upsertLocalProject(localProject);
        return localProject;
    }

    const hosting = await getOrCreateHostingConfig();

    const hostedSource = projectId
        ? await uploadImageToHosting({
              hosting,
              url: item.sourceImage,
              projectId,
              label: "source",
          })
        : null;

    const hostedRender =
        projectId && item.renderedImage
            ? await uploadImageToHosting({
                  hosting,
                  url: item.renderedImage,
                  projectId,
                  label: "rendered",
              })
            : null;

    const resolvedSource =
        hostedSource?.url ||
        (isHostedUrl(item.sourceImage)
            ? item.sourceImage
            : "");

    if (!resolvedSource) {
        console.warn("Failed to host source image, skipping save.");
        return null;
    }

    const resolvedRender = hostedRender?.url
        ? hostedRender?.url
        : item.renderedImage && isHostedUrl(item.renderedImage)
            ? item.renderedImage
            : undefined;

    const {
        sourcePath: _sourcePath,
        renderedPath: _renderedPath,
        publicPath: _publicPath,
        ...rest
    } = item;

    const payload: DesignItem = {
        ...rest,
        id: projectId,
        sourceImage: resolvedSource,
        renderedImage: resolvedRender,
    };

    try {
        const response = await puter.workers.exec(
            `${PUTER_WORKER_URL}/api/projects/save`,
            {
                method: "POST",
                body: JSON.stringify({
                    project: payload,
                    visibility,
                }),
            },
        );

        if (!response.ok) {
            console.error(
                "failed to save the project",
                await response.text(),
            );
            // Persist locally so the UI still works.
            upsertLocalProject(payload);
            return payload;
        }

        // Some environments respond with an empty body which will cause
        // response.json() to throw "Unexpected end of JSON input".
        // Read the raw text first and only parse if it is non‑empty.
        const raw = await response.text();

        if (!raw) {
            // No JSON returned from the worker – fall back to the payload we sent
            // so the app can continue to work locally.
            upsertLocalProject(payload);
            return payload;
        }

        let data: { project?: DesignItem | null } | null = null;
        try {
            data = JSON.parse(raw) as { project?: DesignItem | null };
        } catch (parseError) {
            console.error(
                "Failed to parse project save response:",
                parseError,
            );
            // When parsing fails, still return a usable project object.
            upsertLocalProject(payload);
            return payload;
        }

        const project = data?.project ?? payload;
        upsertLocalProject(project);
        return project;
    } catch (error) {
        console.error("Failed to save project:", error);
        upsertLocalProject(payload);
        return payload;
    }
};

export const getProjects = async () => {
    if (!PUTER_WORKER_URL) {
        console.warn(
            "Missing VITE_PUTER_WORKER_URL; returning projects from local storage.",
        );
        return readLocalProjects();
    }

    try {
        const response = await puter.workers.exec(
            `${PUTER_WORKER_URL}/api/projects/list`,
            { method: "GET" },
        );

        if (!response.ok) {
            console.error(
                "Failed to fetch history",
                await response.text(),
            );
            return readLocalProjects();
        }

        const data = (await response.json()) as {
            projects?: DesignItem[] | null;
        };

        const projects = Array.isArray(data?.projects)
            ? data.projects
            : [];

        // Keep local cache in sync for offline usage.
        if (projects.length) {
            saveLocalProjects(projects);
        }

        return projects;
    } catch (e) {
        console.error("Failed to get projects", e);
        return readLocalProjects();
    }
};

export const getProjectById = async ({ id }: { id: string }) => {
    if (!PUTER_WORKER_URL) {
        console.warn(
            "Missing VITE_PUTER_WORKER_URL; getting project from local storage.",
        );
        return readLocalProjects().find((p) => p.id === id) ?? null;
    }

    console.log("Fetching project with ID:", id);

    try {
        const response = await puter.workers.exec(
            `${PUTER_WORKER_URL}/api/projects/get?id=${encodeURIComponent(
                id,
            )}`,
            { method: "GET" },
        );

        console.log("Fetch project response:", response);

        if (!response.ok) {
            console.error(
                "Failed to fetch project:",
                await response.text(),
            );
            return readLocalProjects().find((p) => p.id === id) ?? null;
        }

        const data = (await response.json()) as {
            project?: DesignItem | null;
        };

        console.log("Fetched project data:", data);

        const project = data?.project ?? null;
        if (project) {
            upsertLocalProject(project);
        }

        return project;
    } catch (error) {
        console.error("Failed to fetch project:", error);
        return readLocalProjects().find((p) => p.id === id) ?? null;
    }
};
