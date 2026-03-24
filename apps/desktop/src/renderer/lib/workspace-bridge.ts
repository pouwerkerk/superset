import { electronTrpcClient } from "renderer/lib/trpc-client";

interface WorkspaceInfo {
	id: string;
	projectId: string;
	name: string;
	branch: string;
	type: string;
	worktreePath: string;
}

interface ListWorkspacesResponse {
	workspaces: WorkspaceInfo[];
}

interface EnsureWorkspaceRequest {
	repoPath: string;
	branch: string;
	name?: string;
}

interface EnsureWorkspaceResponse {
	workspaceId: string;
	projectId: string;
	projectName: string;
	created: boolean;
}

declare global {
	interface Window {
		__listWorkspaces?: () => Promise<ListWorkspacesResponse>;
		__ensureWorkspace?: (
			request: EnsureWorkspaceRequest,
		) => Promise<EnsureWorkspaceResponse>;
	}
}

export function setupWorkspaceBridge(): void {
	window.__listWorkspaces = async (): Promise<ListWorkspacesResponse> => {
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

	window.__ensureWorkspace = async (
		request: EnsureWorkspaceRequest,
	): Promise<EnsureWorkspaceResponse> => {
		// Step 1: Ensure project exists via openFromPath
		const projectResult =
			await electronTrpcClient.projects.openFromPath.mutate({
				path: request.repoPath,
			});

		if (!projectResult.project) {
			throw new Error(
				`Failed to create project for ${request.repoPath}`,
			);
		}

		const { id: projectId, name: projectName } = projectResult.project;

		// Activate the project so it appears in the sidebar
		await electronTrpcClient.projects.activate.mutate({
			projectId,
		});

		// Step 2: Check if workspace already exists for this branch
		const allWorkspaces =
			await electronTrpcClient.workspaces.getAll.query();
		const existing = allWorkspaces.find(
			(ws) => ws.projectId === projectId && ws.branch === request.branch,
		);

		if (existing) {
			return {
				workspaceId: existing.id,
				projectId,
				projectName,
				created: false,
			};
		}

		// Step 3: Create workspace for this branch
		let newWorkspace;
		try {
			// Try using existing branch first
			newWorkspace =
				await electronTrpcClient.workspaces.create.mutate({
					projectId,
					name: request.name ?? request.branch,
					branchName: request.branch,
					useExistingBranch: true,
				});
		} catch {
			// Branch doesn't exist yet — create it
			newWorkspace =
				await electronTrpcClient.workspaces.create.mutate({
					projectId,
					name: request.name ?? request.branch,
					branchName: request.branch,
					useExistingBranch: false,
				});
		}

		return {
			workspaceId: newWorkspace.workspace.id,
			projectId,
			projectName,
			created: true,
		};
	};
}
