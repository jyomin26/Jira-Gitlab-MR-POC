const axios = require('axios');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require("@google/generative-ai");

require('dotenv').config();

const app = express();
app.use(express.json());

// ----- Env Vars -----
const {
  GITLAB_PROJECT_ID,
  GITLAB_API_URL,
  GITLAB_TOKEN,
  GITLAB_BRANCH_NAME,
  JIRA_BASE_URL,
  JIRA_EMAIL,
  JIRA_API_TOKEN,
  GEMINI_API_KEY,
  GEMINI_API_URL,
  GEMINI_MODEL 
} = process.env;


// ----------------- GitLab API instance -----------------
  const gitlabApi = axios.create({
  baseURL: GITLAB_API_URL,
  headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
});

const geminiApi = axios.create({
    baseURL: GEMINI_API_URL,
    params: {
        key: GEMINI_API_KEY,
    },
});


// Fetch Jira ticket details
async function getJiraDetails(ticketId) {
console.log(`Fetching Jira ticket: ${ticketId}`);
  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}`;
  try {
    const response = await axios.get(url, {
      auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
      headers: { 'Accept': 'application/json' }
    });
    console.log(`Received Jira Ticket details`);
    return response.data;
  } catch (err) {
    if (err.response) {
      console.error(`Jira API Error: ${err.response.status} ${err.response.statusText}`);
      console.error('Response:', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('Error fetching Jira issue:', err.message);
    }
    throw err;
  }
}


// ----- GitLab helpers -----
async function getCommits(branch) {
  const res = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/repository/commits?ref_name=${branch}`);
  return res.data;
}

// Fetch diff for a commit
async function getCommitDiff(commitId) {
  const res = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/repository/commits/${commitId}/diff`);
  return res.data;
}

// Create or update MR description
async function updateMRDescription(branch, description) {
  const res = await gitlabApi.get(`/projects/${GITLAB_PROJECT_ID}/merge_requests`, {
    params: { source_branch: branch, state: 'opened' }
  });

  if (res.data.length === 0) {
    await gitlabApi.post(`/projects/${GITLAB_PROJECT_ID}/merge_requests`, {
      source_branch: branch,
      target_branch: 'master',
      title: `MR for ${branch}`,
      description
    });
  } else {
    const mr = res.data[0];
    await gitlabApi.put(`/projects/${GITLAB_PROJECT_ID}/merge_requests/${mr.iid}`, {
      description
    });
  }
}


// ----- Gemini summarization -----
async function summarizeWithGemini(text) {
   console.log(`Summarizing description using Gemini AI`);
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL});
  
  const prompt = `
  Summarize these code changes in a clear, concise way for a GitLab Merge Request description: Do not include a separate title line, only bullet points:
  ${text}
  `;
  
  const result = await model.generateContent(prompt);
  return result.response.text();
}


function parseJiraDescription(adf) {
 if (!adf) return '';

  let text = '';

  function traverse(node) {
    if (node.type === 'text') {
      text += node.text || '';
    }
    if (node.type === 'hardBreak') {
      text += '\n';
    }
    if (node.content) {
      node.content.forEach(traverse);
    }
    if (node.type === 'paragraph') {
      text += '\n\n';
    }
  }

  traverse(adf);
  return text.trim();
}



// ----------------- Main function -----------------
async function createUpdateMR() {
  try {
    console.log(`Processing branch: ${GITLAB_BRANCH_NAME}`);

    const commits = await getCommits(GITLAB_BRANCH_NAME);
    if (commits.length === 0) return console.warn('No commits found');

    const jiraRegex = /[A-Z]+-\d+/;
    let jiraTickets = new Set();

    // Branch name first
    const branchMatch = GITLAB_BRANCH_NAME.match(jiraRegex);
    if (branchMatch) {
      jiraTickets.add(branchMatch[0]);
    } else {
      // Fallback to commit messages
      commits.forEach(commit => {
        const matches = commit.title.match(jiraRegex);
        if (matches) matches.forEach(ticket => jiraTickets.add(ticket));
      });
    }

    if (jiraTickets.size === 0) console.warn('No Jira tickets found in branch or commits');

    // ---------------- Fetch Jira details ----------------
    let jiraDetailsText = '';
    for (const ticket of jiraTickets) {
      try {
         console.log(`Ticket found: ${ticket}`);
        const jiraData = await getJiraDetails(ticket);
        const descriptionText = parseJiraDescription(jiraData.fields.description);
        jiraDetailsText += `\n### Jira: ${ticket}\n\n`;
        jiraDetailsText += `**Title:** ${jiraData.fields.summary}\n\n`;
        jiraDetailsText += `**Description:** ${descriptionText}\n\n`;
       // jiraDetailsText += `**Status:** ${jiraData.fields.status.name}\n\n`;
        //jiraDetailsText += `**Assignee:** ${jiraData.fields.assignee?.displayName || 'Unassigned'}\n\n`;
        jiraDetailsText += `**URL:** ${JIRA_BASE_URL}/browse/${ticket}\n\n`;
      } catch (err) {
        jiraDetailsText += `\n### Jira: ${ticket} (Error fetching details)\n\n`;
         console.log(`Error found: ${jticket}`);
      }
    }


    // Diff Summary
    let allDiffs = '';
    const seenFiles = new Set();
    for (const commit of commits) {
      const diffs = await getCommitDiff(commit.id);
      for (const diff of diffs) {
        if (!seenFiles.has(diff.new_path)) {
          allDiffs += `\n**${diff.new_path}**\n\`\`\`diff\n${diff.diff}\n\`\`\`\n`;
          seenFiles.add(diff.new_path);
        }
      }
    }

    // Summarize diffs with Gemini
    const geminiSummary = await summarizeWithGemini(allDiffs);

    // Final MR description
    let description = `## Changes in branch ${GITLAB_BRANCH_NAME}\n`;
    description += jiraDetailsText;
    description += `\n### Diff Summary (AI Generated)\n${geminiSummary}\n`;
   // description += `\n### Raw Changes\n${allDiffs}`;
    await updateMRDescription(GITLAB_BRANCH_NAME, description);

    console.log('Merge Request updated successfully');
  } catch (err) {
    console.error('Error updating MR:', err.response?.data || err.message);
  }
}



// ----------------- Run script -----------------
createUpdateMR();




