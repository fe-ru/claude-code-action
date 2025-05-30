#!/usr/bin/env bun
/**
 * Prepare the Claude action by checking trigger conditions,
 * verifying human actor, and creating the initial tracking comment.
 */

import * as core from "@actions/core";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

import { setupGitHubToken } from "../github/token";
import { checkTriggerAction } from "../github/validation/trigger";
import { checkHumanActor } from "../github/validation/actor";
import { checkWritePermissions } from "../github/validation/permissions";
import { createInitialComment } from "../github/operations/comments/create-initial";
import { setupBranch } from "../github/operations/branch";
import { updateTrackingComment } from "../github/operations/comments/update-with-branch";
import { prepareMcpConfig } from "../mcp/install-mcp-server";
import { createPrompt } from "../create-prompt";
import { createOctokit } from "../github/api/client";
import { fetchGitHubData } from "../github/data/fetcher";
import { parseGitHubContext } from "../github/context";

/*──────────────────────────────────────────
  OAuth Refresh Handling
  ──────────────────────────────────────────*/

async function refreshOAuthToken(refreshToken: string): Promise<{
  accessToken: string;
  expiresAt: number;
}> {
  console.log("Refreshing OAuth token…");

  const clientId = process.env.CLAUDE_OAUTH_CLIENT_ID ?? "";
  const clientSecret = process.env.CLAUDE_OAUTH_CLIENT_SECRET ?? "";

  const response = await fetch("https://api.anthropic.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to refresh token: ${response.status} ${errorText}`,
    );
  }

  const data = await response.json();

  console.log("OAuth token successfully refreshed");

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

async function setupOAuthCredentials() {
  const refreshToken = process.env.CLAUDE_OAUTH_REFRESH_TOKEN ?? "";
  if (!refreshToken) throw new Error("CLAUDE_OAUTH_REFRESH_TOKEN is missing");

  let accessToken = process.env.CLAUDE_ACCESS_TOKEN ?? "";
  let expiresAtMs = Number(process.env.CLAUDE_EXPIRES_AT ?? 0);
  const now = Date.now();

  // Refresh if token is absent or expiring in ≤5 min
  if (!accessToken || expiresAtMs <= now + 5 * 60 * 1000) {
    const refreshed = await refreshOAuthToken(refreshToken);
    accessToken = refreshed.accessToken;
    expiresAtMs = refreshed.expiresAt;
  } else {
    console.log("OAuth token is still valid");
  }

  // Write ~/.claude/credentials.json
  const claudeDir = join(homedir(), ".claude");
  await mkdir(claudeDir, { recursive: true });

  const credentialsPath = join(claudeDir, "credentials.json");
  const credentialsData = {
    claudeAiOauth: {
      accessToken: accessToken,
      refreshToken: refreshToken,
      expiresAt: expiresAtMs,
      scopes: ["user:inference", "user:profile"],
    },
  };
  await writeFile(credentialsPath, JSON.stringify(credentialsData, null, 2));

  console.log(`OAuth credentials written to ${credentialsPath}`);
}

/*──────────────────────────────────────────
  Main Prepare Flow
  ──────────────────────────────────────────*/

async function run() {
  try {
    const githubToken = await setupGitHubToken();
    const octokit = createOctokit(githubToken);
    const context = parseGitHubContext();

    if (
      !(await checkWritePermissions(octokit.rest, context))
    ) {
      throw new Error("Actor does not have write permissions");
    }

    if (!(await checkTriggerAction(context))) {
      console.log("No trigger found, skipping remaining steps");
      return;
    }

    await checkHumanActor(octokit.rest, context);

    const commentId = await createInitialComment(octokit.rest, context);
    const githubData = await fetchGitHubData({
      octokits: octokit,
      repository: `${context.repository.owner}/${context.repository.repo}`,
      prNumber: context.entityNumber.toString(),
      isPR: context.isPR,
    });

    const branchInfo = await setupBranch(octokit, githubData, context);

    if (branchInfo.claudeBranch) {
      await updateTrackingComment(
        octokit,
        context,
        commentId,
        branchInfo.claudeBranch,
      );
    }

    await createPrompt(
      commentId,
      branchInfo.defaultBranch,
      branchInfo.claudeBranch,
      githubData,
      context,
    );

    const mcpConfig = await prepareMcpConfig(
      githubToken,
      context.repository.owner,
      context.repository.repo,
      branchInfo.currentBranch,
    );

    if (process.env.USE_OAUTH === "true") {
      await setupOAuthCredentials();
    }

    core.setOutput("mcp_config", mcpConfig);
    core.setOutput("github_token", githubToken);
  } catch (error) {
    core.setFailed(`Prepare step failed with error: ${error}`);
    process.exit(1);
  }
}

if (import.meta.main) run();
