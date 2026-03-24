import { electronTrpcClient } from "renderer/lib/trpc-client";
import { electronQueryClient } from "renderer/providers/ElectronTRPCProvider";
import { useTabsStore } from "renderer/stores/tabs/store";

// --- Types ---

interface WorkspaceInfo {
	id: string;
	projectId: string;
	name: string;
	branch: string;
	type: string;
	worktreePath: string;
}

interface CreateWorkspaceRequest {
	projectPath: string;
	branch: string;
	worktreePath?: string; // External worktree path (e.g., from Cuttlefish)
	name?: string;
}

interface CreateWorkspaceResponse {
	workspaceId: string;
	projectId: string;
	projectName: string;
	status: "ready" | "created";
}

interface WorkspaceStatusResponse {
	status: "ready" | "initializing";
	presets: Array<{ id: string; name: string; commands: string[] }>;
}

interface RunInWorkspaceRequest {
	preset: string;
	prompt?: string;
	env?: Record<string, string>;
	cwd?: string;
}

interface RunInWorkspaceResponse {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

declare global {
	interface Window {
		__listWorkspaces?: () => Promise<{ workspaces: WorkspaceInfo[] }>;
		__createWorkspace?: (
			request: CreateWorkspaceRequest,
		) => Promise<CreateWorkspaceResponse>;
		__workspaceStatus?: (
			workspaceId: string,
		) => Promise<WorkspaceStatusResponse>;
		__runInWorkspace?: (
			workspaceId: string,
			request: RunInWorkspaceRequest,
		) => Promise<RunInWorkspaceResponse>;
	}
}

// --- Helpers ---

async function invalidateSidebar(): Promise<void> {
	await Promise.all([
		electronQueryClient.invalidateQueries({
			queryKey: [["projects", "getRecents"]],
		}),
		electronQueryClient.invalidateQueries({
			queryKey: [["workspaces"]],
		}),
	]);
}

// --- Bridge ---

export function setupWorkspaceBridge(): void {
	// GET /api/workspaces
	window.__listWorkspaces = async () => {
		const allWorkspaces =
			await electronTrpcClient.workspaces.getAll.query();
		return {
			workspaces: allWorkspaces.map((ws) => ({
				id: ws.id,
				projectId: ws.projectId,
				name: ws.name,
				branch: ws.branch,
				type: ws.type,
				worktreePath: ws.worktreePath,
			})),
		};
	};

	// POST /api/workspaces
	window.__createWorkspace = async (request) => {
		// Step 1: Ensure project exists
		const projectResult =
			await electronTrpcClient.projects.openFromPath.mutate({
				path: request.projectPath,
			});

		if (!projectResult.project) {
			throw new Error(
				`Failed to create project for ${request.projectPath}`,
			);
		}

		const { id: projectId, name: projectName } = projectResult.project;

		// Activate so it appears in sidebar
		await electronTrpcClient.projects.activate.mutate({ projectId });

		// Step 2: Import any external worktrees (e.g., created by Cuttlefish)
		// This picks up worktrees that exist on disk but aren't tracked by Superset
		await electronTrpcClient.workspaces.importAllWorktrees.mutate({
			projectId,
		});

		// Step 3: Find existing workspace for this branch
		const allWorkspaces =
			await electronTrpcClient.workspaces.getAll.query();
		const existing = allWorkspaces.find(
			(ws) =>
				ws.projectId === projectId && ws.branch === request.branch,
		);

		if (existing) {
			await invalidateSidebar();
			return {
				workspaceId: existing.id,
				projectId,
				projectName,
				status: "ready",
			};
		}

		// Step 4: No existing workspace — create one
		let newWorkspace;
		try {
			newWorkspace =
				await electronTrpcClient.workspaces.create.mutate({
					projectId,
					name: request.name ?? request.branch,
					branchName: request.branch,
					useExistingBranch: true,
				});
		} catch {
			newWorkspace =
				await electronTrpcClient.workspaces.create.mutate({
					projectId,
					name: request.name ?? request.branch,
					branchName: request.branch,
					useExistingBranch: false,
				});
		}

		await invalidateSidebar();

		return {
			workspaceId: newWorkspace.workspace.id,
			projectId,
			projectName,
			status: "created",
		};
	};

	// GET /api/workspaces/:id/status
	window.__workspaceStatus = async (workspaceId) => {
		const presets =
			await electronTrpcClient.settings.getTerminalPresets.query();

		return {
			status: "ready" as const,
			presets: presets.map((p) => ({
				id: p.id,
				name: p.name,
				commands: p.commands,
			})),
		};
	};

	// POST /api/workspaces/:id/run
	window.__runInWorkspace = async (workspaceId, request) => {
		const store = useTabsStore.getState();

		// Resolve preset by name
		const presets =
			await electronTrpcClient.settings.getTerminalPresets.query();
		const preset = presets.find(
			(p) => p.name.toLowerCase() === request.preset.toLowerCase(),
		);
		if (!preset) {
			throw new Error(
				`Preset "${request.preset}" not found. Available: ${presets.map((p) => p.name).join(", ")}`,
			);
		}

		// Create tab + pane
		const { tabId, paneId } = store.addTab(workspaceId, {
			initialCwd: request.cwd,
		});

		// Attach terminal
		await electronTrpcClient.terminal.createOrAttach.mutate({
			paneId,
			tabId,
			workspaceId,
			cwd: request.cwd,
			joinPending: true,
		});

		// Build command: env exports + preset command
		const parts: string[] = [];

		if (request.env && Object.keys(request.env).length > 0) {
			for (const [key, value] of Object.entries(request.env)) {
				parts.push(`export ${key}=${JSON.stringify(value)}`);
			}
		}

		// Use preset's configured command
		const presetCommand = preset.commands.join(" && ");
		parts.push(presetCommand);

		const fullCommand = parts.join(" && ");
		await electronTrpcClient.terminal.write.mutate({
			paneId,
			data: `${fullCommand}\n`,
			throwOnError: true,
		});

		// If a prompt is provided, wait for the agent to start,
		// then inject it via bracketed paste so multi-line text
		// with special characters is handled atomically.
		if (request.prompt) {
			// Wait for Claude Code to initialize and enable bracketed paste mode
			await new Promise((resolve) => setTimeout(resolve, 4000));

			// Bracketed paste: \x1b[200~ ... \x1b[201~ tells the terminal
			// to treat the content as pasted text, not typed commands.
			// Claude Code (and most modern CLI apps) handle this correctly.
			const pasteStart = "\x1b[200~";
			const pasteEnd = "\x1b[201~";
			const data = `${pasteStart}${request.prompt}${pasteEnd}\n`;

			await electronTrpcClient.terminal.write.mutate({
				paneId,
				data,
				throwOnError: true,
			});
		}

		return { paneId, tabId, workspaceId };
	};
}
