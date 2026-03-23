import { electronTrpcClient } from "renderer/lib/trpc-client";
import { useTabsStore } from "renderer/stores/tabs/store";

interface LaunchTerminalRequest {
	command: string;
	cwd: string;
	name?: string;
	workspaceId?: string;
	env?: Record<string, string>;
}

interface LaunchTerminalResponse {
	paneId: string;
	tabId: string;
	workspaceId: string;
}

declare global {
	interface Window {
		__launchTerminal?: (
			request: LaunchTerminalRequest,
		) => Promise<LaunchTerminalResponse>;
	}
}

export function setupTerminalLaunchBridge(): void {
	window.__launchTerminal = async (
		request: LaunchTerminalRequest,
	): Promise<LaunchTerminalResponse> => {
		const store = useTabsStore.getState();

		// Find target workspace — use provided or first available
		const workspaceId =
			request.workspaceId ?? Object.keys(store.activeTabIds)[0];
		if (!workspaceId) {
			throw new Error("No workspace available");
		}

		// Create new tab with terminal pane
		const { tabId, paneId } = store.addTab(workspaceId, {
			initialCwd: request.cwd,
		});

		// Build full command with any extra env vars prefixed
		let fullCommand = request.command;
		if (request.env && Object.keys(request.env).length > 0) {
			const exports = Object.entries(request.env)
				.map(([k, v]) => `export ${k}=${JSON.stringify(v)}`)
				.join(" && ");
			fullCommand = `${exports} && ${request.command}`;
		}

		// Initialize the terminal session (creates the PTY)
		await electronTrpcClient.terminal.createOrAttach.mutate({
			paneId,
			tabId,
			workspaceId,
			cwd: request.cwd,
			joinPending: true,
		});

		// Write the command to the terminal (appending newline to execute it)
		const data = fullCommand.endsWith("\n") ? fullCommand : `${fullCommand}\n`;
		await electronTrpcClient.terminal.write.mutate({
			paneId,
			data,
			throwOnError: true,
		});

		return { paneId, tabId, workspaceId };
	};
}
