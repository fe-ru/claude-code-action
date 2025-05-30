#!/usr/bin/env bun
/**
* Prepare the Claude action by checking trigger conditions, verifying human actor,
* and creating the initial tracking comment
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

// OAuth トークンをリフレッシュする関数
async function refreshOAuthToken(refreshToken: string): Promise<{
 accessToken: string;
 expiresAt: number;
}> {
 console.log("Refreshing OAuth token...");
 
 // TODO: AnthropicのOAuth refresh APIの正確なエンドポイントとパラメータを確認
 const response = await fetch("https://api.anthropic.com/oauth/token", {
   method: "POST",
   headers: {
     "Content-Type": "application/x-www-form-urlencoded",
   },
   body: new URLSearchParams({
     grant_type: "refresh_token",
     refresh_token: refreshToken,
     // client_idが必要な場合はここに追加
   }),
 });

 if (!response.ok) {
   const errorText = await response.text();
   throw new Error(`Failed to refresh token: ${response.status} ${errorText}`);
 }

 const data = await response.json();
 
 console.log("OAuth token successfully refreshed");
 
 return {
   accessToken: data.access_token,
   expiresAt: Date.now() + data.expires_in * 1000,
 };
}

// OAuth認証情報を設定する関数
async function setupOAuthCredentials() {
 const accessToken = process.env.CLAUDE_ACCESS_TOKEN || "";
 const refreshToken = process.env.CLAUDE_REFRESH_TOKEN || "";
 const expiresAt = process.env.CLAUDE_EXPIRES_AT || "";
 
 if (!accessToken || !refreshToken || !expiresAt) {
   throw new Error("OAuth credentials are incomplete");
 }
 
 // 有効期限をチェック
 const expiresAtMs = parseInt(expiresAt);
 const now = Date.now();
 
 let finalAccessToken = accessToken;
 let finalExpiresAt = expiresAtMs;
 
 // トークンが期限切れまたは5分以内に期限切れになる場合
 if (expiresAtMs <= now + 5 * 60 * 1000) {
   console.log("OAuth token expired or expiring soon, refreshing...");
   
   try {
     const refreshed = await refreshOAuthToken(refreshToken);
     finalAccessToken = refreshed.accessToken;
     finalExpiresAt = refreshed.expiresAt;
   } catch (error) {
     console.error("Failed to refresh OAuth token:", error);
     throw error;
   }
 } else {
   console.log("OAuth token is still valid");
 }
 
 // credentials.jsonを作成
 const claudeDir = join(homedir(), ".claude");
 await mkdir(claudeDir, { recursive: true });
 
 const credentialsData = {
   claudeAiOauth: {
     accessToken: finalAccessToken,
     refreshToken: refreshToken,
     expiresAt: finalExpiresAt,
     scopes: ["user:inference", "user:profile"],
   },
 };
 
 const credentialsPath = join(claudeDir, ".credentials.json");
 await writeFile(credentialsPath, JSON.stringify(credentialsData, null, 2));
 
 console.log(`OAuth credentials written to ${credentialsPath}`);
}

async function run() {
 try {
   // Step 1: Setup GitHub token
   const githubToken = await setupGitHubToken();
   const octokit = createOctokit(githubToken);
   
   // Step 2: Parse GitHub context (once for all operations)
   const context = parseGitHubContext();
   
   // Step 3: Check write permissions
   const hasWritePermissions = await checkWritePermissions(
     octokit.rest,
     context,
   );
   if (!hasWritePermissions) {
     throw new Error(
       "Actor does not have write permissions to the repository",
     );
   }
   
   // Step 4: Check trigger conditions
   const containsTrigger = await checkTriggerAction(context);
   if (!containsTrigger) {
     console.log("No trigger found, skipping remaining steps");
     return;
   }
   
   // Step 5: Check if actor is human
   await checkHumanActor(octokit.rest, context);
   
   // Step 6: Create initial tracking comment
   const commentId = await createInitialComment(octokit.rest, context);
   
   // Step 7: Fetch GitHub data (once for both branch setup and prompt creation)
   const githubData = await fetchGitHubData({
     octokits: octokit,
     repository: `${context.repository.owner}/${context.repository.repo}`,
     prNumber: context.entityNumber.toString(),
     isPR: context.isPR,
   });
   
   // Step 8: Setup branch
   const branchInfo = await setupBranch(octokit, githubData, context);
   
   // Step 9: Update initial comment with branch link (only for issues that created a new branch)
   if (branchInfo.claudeBranch) {
     await updateTrackingComment(
       octokit,
       context,
       commentId,
       branchInfo.claudeBranch,
     );
   }
   
   // Step 10: Create prompt file
   await createPrompt(
     commentId,
     branchInfo.defaultBranch,
     branchInfo.claudeBranch,
     githubData,
     context,
   );
   
   // Step 11: Get MCP configuration
   const mcpConfig = await prepareMcpConfig(
     githubToken,
     context.repository.owner,
     context.repository.repo,
     branchInfo.currentBranch,
   );
   
   // Step 12: Setup OAuth credentials if using OAuth
   const useOAuth = process.env.USE_OAUTH === 'true';
   if (useOAuth) {
     try {
       await setupOAuthCredentials();
     } catch (error) {
       console.error("Failed to setup OAuth credentials:", error);
       throw error;
     }
   }
   
   // 出力を設定
   core.setOutput("mcp_config", mcpConfig);
   core.setOutput("github_token", githubToken);
   
 } catch (error) {
   core.setFailed(`Prepare step failed with error: ${error}`);
   process.exit(1);
 }
}

if (import.meta.main) {
 run();
}
