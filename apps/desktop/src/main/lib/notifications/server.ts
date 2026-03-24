import { EventEmitter } from "node:events";
import { BrowserWindow } from "electron";
import express from "express";
import { handleAuthCallback } from "lib/trpc/routers/auth/utils/auth-functions";
import { NOTIFICATION_EVENTS } from "shared/constants";
import { env } from "shared/env.shared";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { HOOK_PROTOCOL_VERSION } from "../terminal/env";
import { mapEventType } from "./map-event-type";
import { resolvePaneId } from "./resolve-pane-id";

// Re-export types for backwards compatibility
export type {
	AgentLifecycleEvent,
	NotificationIds,
} from "shared/notification-types";
export { resolvePaneId } from "./resolve-pane-id";

/**
 * The environment this server is running in.
 * Used to validate incoming hook requests and detect cross-environment issues.
 */
const SERVER_ENV =
	env.NODE_ENV === "development" ? "development" : "production";
const debugHooksOverride = process.env.SUPERSET_DEBUG_HOOKS?.trim();
const DEBUG_HOOKS_ENABLED =
	debugHooksOverride === undefined
		? SERVER_ENV === "development"
		: !/^(0|false)$/i.test(debugHooksOverride);

/**
 * Broadcasts normalized agent lifecycle events from the local hook server.
 */
export const notificationsEmitter = new EventEmitter();

const app = express();

// Parse JSON request bodies
app.use(express.json());

// CORS
app.use((req, res, next) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	if (req.method === "OPTIONS") {
		return res.status(200).end();
	}
	next();
});

// Agent lifecycle hook
app.get("/hook/complete", (req, res) => {
	const {
		paneId,
		tabId,
		workspaceId,
		sessionId,
		hookSessionId,
		resourceId,
		eventType,
		env: clientEnv,
		version,
	} = req.query;

	// Environment validation: detect dev/prod cross-talk
	// We still return success to not block the agent, but log a warning
	if (clientEnv && clientEnv !== SERVER_ENV) {
		console.warn(
			`[notifications] Environment mismatch: received ${clientEnv} request on ${SERVER_ENV} server. ` +
				`This may indicate a stale hook or misconfigured terminal. Ignoring request.`,
		);
		return res.json({ success: true, ignored: true, reason: "env_mismatch" });
	}

	// Log version for debugging (helpful when troubleshooting hook issues)
	if (version && version !== HOOK_PROTOCOL_VERSION) {
		console.log(
			`[notifications] Received hook v${version} request (server expects v${HOOK_PROTOCOL_VERSION})`,
		);
	}

	const mappedEventType = mapEventType(eventType as string | undefined);

	// Unknown or missing eventType: return success but don't process
	// This ensures forward compatibility and doesn't block the agent
	if (!mappedEventType) {
		if (eventType) {
			console.log("[notifications] Ignoring unknown eventType:", eventType);
		}
		return res.json({ success: true, ignored: true });
	}

	const resolvedPaneId = resolvePaneId(
		paneId as string | undefined,
		tabId as string | undefined,
		workspaceId as string | undefined,
		sessionId as string | undefined,
	);

	const event: AgentLifecycleEvent = {
		paneId: resolvedPaneId,
		tabId: tabId as string | undefined,
		workspaceId: workspaceId as string | undefined,
		eventType: mappedEventType,
	};

	if (DEBUG_HOOKS_ENABLED) {
		console.log("[notifications] hook event received", {
			eventType,
			mappedEventType,
			paneId: paneId as string | undefined,
			tabId: tabId as string | undefined,
			workspaceId: workspaceId as string | undefined,
			sessionId: sessionId as string | undefined,
			hookSessionId: hookSessionId as string | undefined,
			resourceId: resourceId as string | undefined,
			resolvedPaneId,
		});
	}

	notificationsEmitter.emit(NOTIFICATION_EVENTS.AGENT_LIFECYCLE, event);

	res.json({ success: true, paneId: resolvedPaneId, tabId });
});

// Health check
app.get("/health", (_req, res) => {
	res.json({ status: "ok" });
});

// OAuth callback fallback for Linux/dev environments where custom URI handlers
// are unreliable. Browser can hit localhost directly to complete sign-in.
app.get("/auth/callback", async (req, res) => {
	const token = req.query.token;
	const expiresAt = req.query.expiresAt;
	const state = req.query.state;

	if (
		typeof token !== "string" ||
		typeof expiresAt !== "string" ||
		typeof state !== "string"
	) {
		return res
			.status(400)
			.json({ success: false, error: "Missing auth params" });
	}

	const result = await handleAuthCallback({ token, expiresAt, state });
	if (!result.success) {
		return res.status(400).json(result);
	}

	const mainWindow = BrowserWindow.getAllWindows()[0];
	if (mainWindow) {
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.focus();
	}

	// Return HTML since the browser navigated here directly (not fetch).
	res.setHeader("Content-Type", "text/html");
	return res.send(`<!DOCTYPE html>
<html><head><title>Superset</title></head>
<body style="font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0a0a0a;color:#fafafa;">
<div style="text-align:center">
<h2 style="margin-bottom:8px">Signed in successfully</h2>
<p style="opacity:0.6">You can close this tab and return to the desktop app.</p>
</div>
</body></html>`);
});

// --- Workspace API for external orchestration (e.g., Sepia/gangliad) ---

function getMainWindow() {
	const win = BrowserWindow.getAllWindows()[0];
	if (!win) throw new Error("No Superset window available");
	return win;
}

async function bridgeCall(method: string, ...args: unknown[]): Promise<unknown> {
	const win = getMainWindow();
	const argsJson = args.map((a) => JSON.stringify(a)).join(", ");
	return win.webContents.executeJavaScript(
		`window.${method}(${argsJson})`,
	);
}

// GET /api/workspaces — list all workspaces
app.get("/api/workspaces", async (_req, res) => {
	try {
		const result = await bridgeCall("__listWorkspaces");
		return res.json(result);
	} catch (err) {
		console.error("[api] workspace list failed:", err);
		return res.status(500).json({ error: "list_failed", message: String(err) });
	}
});

// POST /api/workspaces — create or find a workspace for a project + branch
app.post("/api/workspaces", async (req, res) => {
	const { projectPath, branch, worktreePath, name } = req.body;

	if (!projectPath || !branch) {
		return res.status(400).json({
			error: "missing_fields",
			message: "projectPath and branch are required",
		});
	}

	try {
		const result = await bridgeCall("__createWorkspace", {
			projectPath,
			branch,
			worktreePath,
			name,
		});
		return res.status(201).json(result);
	} catch (err) {
		console.error("[api] workspace create failed:", err);
		return res.status(500).json({ error: "create_failed", message: String(err) });
	}
});

// GET /api/workspaces/:id/status — check workspace readiness and available presets
app.get("/api/workspaces/:id/status", async (req, res) => {
	try {
		const result = await bridgeCall("__workspaceStatus", req.params.id);
		return res.json(result);
	} catch (err) {
		console.error("[api] workspace status failed:", err);
		return res.status(500).json({ error: "status_failed", message: String(err) });
	}
});

// POST /api/workspaces/:id/run — run a preset in a workspace with optional prompt
app.post("/api/workspaces/:id/run", async (req, res) => {
	const { preset, prompt, env: extraEnv, cwd } = req.body;

	if (!preset) {
		return res.status(400).json({
			error: "missing_fields",
			message: "preset is required",
		});
	}

	try {
		const result = await bridgeCall("__runInWorkspace", req.params.id, {
			preset,
			prompt,
			env: extraEnv,
			cwd,
		});
		return res.status(201).json(result);
	} catch (err) {
		console.error("[api] workspace run failed:", err);
		return res.status(500).json({ error: "run_failed", message: String(err) });
	}
});

// --- Legacy endpoints (kept for backward compatibility) ---

// GET /workspaces — legacy alias
app.get("/workspaces", async (_req, res) => {
	try {
		const result = await bridgeCall("__listWorkspaces");
		return res.json(result);
	} catch (err) {
		return res.status(500).json({ error: "list_failed", message: String(err) });
	}
});

// POST /workspaces/ensure — legacy alias
app.post("/workspaces/ensure", async (req, res) => {
	const { repoPath, branch, worktreePath, name } = req.body;
	if (!repoPath || !branch) {
		return res.status(400).json({
			error: "missing_fields",
			message: "repoPath and branch are required",
		});
	}
	try {
		const result = await bridgeCall("__createWorkspace", {
			projectPath: repoPath,
			branch,
			worktreePath,
			name,
		});
		return res.status(201).json(result);
	} catch (err) {
		return res.status(500).json({ error: "ensure_failed", message: String(err) });
	}
});

// Terminal launch endpoint for external orchestration
app.post("/terminal/launch", async (req, res) => {
	const { command, cwd, name, workspaceId, env: extraEnv } = req.body;

	if (!command || !cwd) {
		return res.status(400).json({
			error: "missing_fields",
			message: "command and cwd are required",
		});
	}

	const mainWindow = BrowserWindow.getAllWindows()[0];
	if (!mainWindow) {
		return res.status(500).json({
			error: "no_window",
			message: "No Superset window available",
		});
	}

	try {
		const requestJson = JSON.stringify({
			command,
			cwd,
			name,
			workspaceId,
			env: extraEnv,
		});

		const result = await mainWindow.webContents.executeJavaScript(
			`window.__launchTerminal(${requestJson})`,
		);

		if (!result || !result.paneId) {
			return res.status(500).json({
				error: "launch_failed",
				message: "Terminal launch bridge returned invalid result",
			});
		}

		return res.status(201).json({
			paneId: result.paneId,
			tabId: result.tabId,
			workspaceId: result.workspaceId,
		});
	} catch (err) {
		console.error("[notifications] terminal launch failed:", err);
		return res.status(500).json({
			error: "launch_failed",
			message: String(err),
		});
	}
});

// 404
app.use((_req, res) => {
	res.status(404).json({ error: "Not found" });
});

/**
 * Exposes the notifications Express app for startup and tests.
 */
export const notificationsApp = app;
