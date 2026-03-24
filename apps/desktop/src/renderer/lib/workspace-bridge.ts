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
	/** How to deliver the prompt to the agent */
	promptMode?: "interactive" | "file" | "flag";
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

// --- Helpers ---

/**
 * Wait for an agent to be ready to accept input by polling the pane's
 * terminal session. We check if the session exists and is attached,
 * which indicates the PTY is running and Claude Code has started.
 *
 * Returns true if readiness was detected, false on timeout.
 */
async function waitForAgentReady(
	paneId: string,
	timeoutMs: number,
): Promise<boolean> {
	const start = Date.now();
	const pollInterval = 500;

	while (Date.now() - start < timeoutMs) {
		try {
			const session =
				await electronTrpcClient.terminal.getSession.query(paneId);
			// Session exists and has been running for a reasonable time
			if (session) {
				// Wait a bit more after session detection for Claude Code banner
				await new Promise((resolve) => setTimeout(resolve, 2000));
				return true;
			}
		} catch {
			// Session not found yet, keep polling
		}
		await new Promise((resolve) => setTimeout(resolve, pollInterval));
	}
	return false;
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

		const mode = request.promptMode ?? "interactive";

		// Set env vars (exclude GANGLIA_PROMPT from shell export — it's too large)
		const envParts: string[] = [];
		if (request.env && Object.keys(request.env).length > 0) {
			for (const [key, value] of Object.entries(request.env)) {
				if (key === "GANGLIA_PROMPT") continue;
				envParts.push(`export ${key}=${JSON.stringify(value)}`);
			}
		}

		if (mode === "file" && request.prompt) {
			// File mode: write prompt to .superset/task.md, launch with -p "$(cat ...)"
			const workspace =
				await electronTrpcClient.workspaces.get.query({
					id: workspaceId,
				});
			if (workspace?.worktreePath) {
				const supersetDir = `${workspace.worktreePath}/.superset`;
				await electronTrpcClient.filesystem.createDirectory.mutate({
					workspaceId,
					absolutePath: supersetDir,
				});
				const taskFile = `${supersetDir}/task-prompt.md`;
				await electronTrpcClient.filesystem.writeFile.mutate({
					workspaceId,
					absolutePath: taskFile,
					content: request.prompt,
					encoding: "utf-8",
				});

				const presetCommand = preset.commands[0] ?? "claude --dangerously-skip-permissions";
				const fileCommand = `${presetCommand} -p "$(cat '.superset/task-prompt.md')"`;
				const parts = [...envParts, fileCommand];
				await electronTrpcClient.terminal.write.mutate({
					paneId,
					data: `${parts.join(" && ")}\n`,
					throwOnError: true,
				});
			}
		} else if (mode === "flag" && request.prompt) {
			// Flag mode: pass prompt directly via -p flag (heredoc for safety)
			const delimiter = "GANGLIA_PROMPT_END";
			const presetCommand = preset.commands[0] ?? "claude --dangerously-skip-permissions";
			const heredocCommand = `${presetCommand} -p "$(cat <<'${delimiter}'\n${request.prompt}\n${delimiter}\n)"`;
			const parts = [...envParts, heredocCommand];
			await electronTrpcClient.terminal.write.mutate({
				paneId,
				data: `${parts.join(" && ")}\n`,
				throwOnError: true,
			});
		} else {
			// Interactive mode: launch preset, wait for agent readiness, paste prompt
			const presetCommand = preset.commands.join(" && ");
			const parts = [...envParts, presetCommand];
			await electronTrpcClient.terminal.write.mutate({
				paneId,
				data: `${parts.join(" && ")}\n`,
				throwOnError: true,
			});

			if (request.prompt) {
				// Wait for Claude Code to initialize.
				// Poll pane status: once a hook fires (Start/Stop), Claude is responsive.
				// Fallback: 5 second timeout.
				const paneReady = await waitForAgentReady(paneId, 8000);
				if (!paneReady) {
					console.warn(
						"[workspace-bridge] Agent readiness timeout — injecting prompt anyway",
					);
				}

				// Inject via bracketed paste for clean multi-line handling
				const pasteStart = "\x1b[200~";
				const pasteEnd = "\x1b[201~";
				await electronTrpcClient.terminal.write.mutate({
					paneId,
					data: `${pasteStart}${request.prompt}${pasteEnd}\n`,
					throwOnError: true,
				});
			}
		}

		return { paneId, tabId, workspaceId };
	};
}
