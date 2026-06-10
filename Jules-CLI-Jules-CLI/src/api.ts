import axios from 'axios';
import { Octokit } from '@octokit/rest';
import { config, logger } from './utils';

const julesApi = axios.create({
  baseURL: config.JULES_API_URL,
  headers: {
    'x-goog-api-key': config.JULES_API_KEY,
    'Content-Type': 'application/json',
  },
});

const octokit = new Octokit({ auth: config.GITHUB_TOKEN });

export async function createShadowRepo(name: string): Promise<string> {
  try {
    logger.info(`Checking for shadow repo: ${name}...`);
    const { data: user } = await octokit.users.getAuthenticated();
    try {
      const { data: repo } = await octokit.repos.get({ owner: user.login, repo: name });
      const authenticatedUrl = repo.clone_url.replace('https://', `https://${config.GITHUB_TOKEN}@`);
      logger.info(`Shadow repo exists: ${repo.clone_url}`);
      return authenticatedUrl;
    } catch (e: any) {
      if (e.status === 404) {
        logger.info(`Creating private shadow repo: ${name}...`);
        const { data: repo } = await octokit.repos.createForAuthenticatedUser({
          name,
          private: true,
          auto_init: false,
        });
        const authenticatedUrl = repo.clone_url.replace('https://', `https://${config.GITHUB_TOKEN}@`);
        return authenticatedUrl;
      }
      throw e;
    }
  } catch (error: any) {
    logger.error(`GitHub API Error: ${error.message}`);
    throw error;
  }
}

export async function createJulesSession(prompt: string, repoUrl: string, branch: string = 'main', model?: string) {
  // Extract owner/repo from URL and clean up any auth tokens
  const match = repoUrl.match(/github\.com[\/:](.+?)\/(.+?)(\.git)?$/);
  if (!match) throw new Error('Invalid GitHub URL');
  const [, owner, repo] = match;
  
  const payload: any = {
    prompt,
    sourceContext: {
      source: `sources/github/${owner}/${repo}`,
      githubRepoContext: {
        startingBranch: branch,
      },
    },
  };

  if (model) {
    payload.model = model;
  }

  const response = await julesApi.post('/sessions', payload);
  return response.data;
}


export async function getSessionStatus(sessionId: string) {
  const response = await julesApi.get(`/sessions/${sessionId}`);
  return response.data;
}

export async function getSessionActivities(sessionId: string) {
  const response = await julesApi.get(`/sessions/${sessionId}/activities`);
  return response.data.activities || [];
}

export async function sendJulesMessage(sessionId: string, prompt: string) {
  const response = await julesApi.post(`/sessions/${sessionId}:sendMessage`, { prompt });
  return response.data;
}

export async function approveJulesPlan(sessionId: string) {
  const response = await julesApi.post(`/sessions/${sessionId}:approvePlan`, {});
  return response.data;
}

export async function listJulesSessions() {
  const response = await julesApi.get('/sessions');
  return response.data.sessions || [];
}

export async function deleteJulesSession(sessionId: string) {
  const response = await julesApi.delete(`/sessions/${sessionId}`);
  return response.data;
}

export async function listUserRepos() {
  try {
    const { data: repos } = await octokit.repos.listForAuthenticatedUser({
      sort: 'updated',
      per_page: 100,
    });
    return repos;
  } catch (error: any) {
    logger.error(`Failed to list GitHub repositories: ${error.message}`);
    return [];
  }
}
